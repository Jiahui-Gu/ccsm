// Per-session warm xterm registry — architectural fix for the
// session-switch 冲顶 / scroll-to-top flash. Originally landed gated
// behind `CCSM_WARM_XTERM=1` (PR #1355); the flag was removed in the
// follow-up refactor and this is now the only terminal path.
//
// Goal (user-stated): "我一个session本来是打开的, 我理解切到另一个session,
// 当前session只是被放在后台了, 就像图层一样, 被盖住了, 那切回来的时候只是简单
// 把他调到最上层." Translation: VS Code-style layer model — each session
// keeps its own xterm Terminal alive in memory; switching sessions is just
// reparenting a DOM wrapper, NOT rebuilding state.
//
// The registry owns the per-entry xterm Terminal AND all input-side
// behaviours that used to live on the legacy singleton: IME composition
// buffering, custom keybindings (Ctrl/Cmd+C/V/A), capture-phase paste
// listener, selection-to-clipboard auto-copy. Listeners that depend on
// `term.textarea` (composition + key handler + capture-phase paste) are
// installed inside `ensureAndShowEntry` AFTER `term.open()` runs — the
// textarea doesn't exist before then.
//
// Transparent-transport invariant: this module fans out PTY data to the
// per-session xterm via `window.ccsmPty.onData` (multi-subscriber, see
// `electron/preload/bridges/ccsmPty.ts`). The bytes themselves are NEVER
// transformed, chunked, throttled, or logged content-side. Only the
// subscription topology changes — same bytes to all subscribers.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import { useStore } from '../stores/store';
import { SCROLLBACK_LINES_DEFAULT } from '../stores/slices/types';
import { warn, log } from '../shared/log';
import { pasteIntoActivePty } from './paste';

/**
 * `compositionupdate` fires once per IME edit; sample every Nth so a long
 * pinyin session doesn't flood the log. Reset on `compositionstart` so
 * each composition counts independently.
 */
const IME_UPDATE_SAMPLE_N = 10;

const DEFAULT_WARM_CAP = 20;
/**
 * Soft cap on `router.buffered` length. The buffering window is normally
 * sub-second (alloc → cold-attach snapshot → applySnapshot drains).
 * 256 chunks ≈ tens of KB at typical chunk sizes — plenty of headroom
 * for a healthy attach, while bounding growth if cold-attach hangs
 * (e.g. term.open() retry path never succeeds). On overflow we drop
 * the OLDEST entry so the most recent live tail survives.
 */
const BUFFERING_SOFT_CAP = 256;

/** LRU cap for the warm registry. Static — no runtime override surface
 *  remains after the `CCSM_WARM_XTERM` flag deletion. If a future need
 *  for tuning surfaces, expose a setting via the store. */
export function getWarmCap(): number {
  return DEFAULT_WARM_CAP;
}

export type WarmEntry = {
  sid: string;
  term: Terminal;
  fit: FitAddon;
  /**
   * DOM wrapper that owns the xterm canvases. Either parented under the
   * active TerminalPane host (visible) or under {@link getOffscreenHolder}
   * (hidden). Reparenting is the entire mechanism for show/hide.
   */
  wrapper: HTMLDivElement;
  /**
   * Per-entry `pty.onData` subscription. Filters incoming chunks by sid so
   * hidden sessions still ingest live PTY output (the whole point of the
   * warm cache — claude in session B keeps emitting while user is on A,
   * and B's xterm WriteBuffer keeps draining behind the scenes).
   *
   * IMPORTANT: this subscription writes to {@link term} regardless of
   * whether the entry is currently active. xterm's WriteBuffer is a
   * Uint8Array-backed FIFO that drains independent of visibility; the
   * canvas atlas does pause paint work via IntersectionObserver under
   * `display:none`, but parse / cell-grid updates continue. Verified
   * against `@xterm/xterm` source.
   */
  dataUnsubscribe: () => void;
  /** Updated on `showEntry`; used for LRU eviction. */
  lastAccessedAt: number;
  /**
   * Whether `term.open(wrapper)` has been called. Deferred from
   * {@link allocEntry} to the first {@link ensureAndShowEntry} so the
   * xterm renderer initializes against the visible host's real geometry
   * rather than the 0x0 / visibility:hidden offscreen holder — the
   * latter leaves the paint scheduler permanently quiesced under xterm
   * 5.5's CanvasAddon/DOM renderer.
   */
  opened: boolean;
  /**
   * Whether the textarea-dependent listeners (IME composition, custom
   * key handler, capture-phase paste, selection-auto-copy) have been
   * installed. They require `term.textarea` to exist, which only happens
   * after `term.open()`, so installation is deferred to the first
   * {@link ensureAndShowEntry} call AFTER `opened` flips true. Idempotent
   * across subsequent shows.
   */
  inputListenersInstalled: boolean;
  /**
   * IME composition state. While a CJK IME is composing, every `term.write`
   * reanchors xterm's hidden textarea and makes the composition preview
   * box jump around. We buffer PTY chunks here and flush on
   * `compositionend`. Reset on each `compositionstart`.
   */
  composing: boolean;
  bufferedDuringComposition: string[];
  imeBufferedBytes: number;
  imeUpdateCount: number;
  imeCompositionStartedAt: number;
  /**
   * Handoff flag between the Ctrl/Cmd+V keydown handler and the
   * capture-phase `paste` listener. When the keydown handler injects a
   * paste, some browsers / Electron versions then dispatch a follow-up
   * native `paste` event — this flag tells the capture listener to
   * swallow that follow-up so we paste exactly once.
   */
  keyboardPasteHandled: boolean;
  /** All input-side disposers (composition listeners, capture-paste,
   *  selection-copy, key handler). Drained in {@link disposeEntry}. */
  inputDisposers: Array<() => void>;
};

/**
 * Per-entry chunk-routing state (Major 1 fix from cold review).
 *
 * The legacy `usePtyAttach` cold path serializes the headless buffer and
 * uses an entry-local `snapSeq` to drop chunks already represented in
 * the serialized snapshot. The warm registry has the same race: between
 * `pty.attach` resolving (main starts broadcasting chunks to our
 * webContents) and the cold-path snapshot being written, the per-entry
 * listener receives live chunks. The previous implementation wrote them
 * straight to `term`, then the cold path called `term.reset()` —
 * silently dropping those chunks forever. They were never replayed.
 *
 * Fix: the listener has three modes.
 *   1. `buffering` (default at alloc): chunks land in {@link buffered}
 *      with their seq, NOT written to term. This is the mode while the
 *      cold path is still in flight.
 *   2. `live`: chunks past `snapSeq` are written directly to term;
 *      chunks <= `snapSeq` are dropped (already in the snapshot, which
 *      the cold path has by now applied). This is the steady state.
 *   3. The transition is driven by {@link applySnapshot}, called by
 *      the cold-attach hook AFTER it has called `term.reset()` and
 *      `term.write(snapshot)`: it sets `snapSeq`, drains
 *      `buffered`-with-`seq > snapSeq` into term in arrival order, and
 *      flips mode to `live`.
 *
 * Warm-cache hits never alloc — they reuse an entry that's already in
 * `live` mode, so warm switching has zero buffering overhead.
 */
type EntryRouter = {
  mode: 'buffering' | 'live';
  snapSeq: number | null;
  buffered: Array<{ seq: number; chunk: string }>;
};

const entryRouters: Map<string, EntryRouter> = new Map();

const warm: Map<string, WarmEntry> = new Map();
let activeSid: string | null = null;
let offscreenHolder: HTMLDivElement | null = null;

// Global PTY exit subscription (Major 2 fix from cold review).
//
// The legacy `usePtyAttach.ts` installed an `onExit` listener per hook
// instance that filtered `evt.sessionId !== getActiveSid()` and silently
// returned for hidden sessions — meaning a backgrounded session that
// crashed left no trace: the user switched back to a "ready" UI with no
// terminal content and no exit overlay. Under the warm model that's a
// much bigger gap because hidden sessions are EXPECTED to keep running.
//
// Fix: install a single module-level listener that calls
// `useStore.getState()._applyPtyExit(sid, ...)` for EVERY sid
// unconditionally. The per-hook effect then reads
// `disconnectedSessions[sessionId]` and flips local state to `exit` when
// it sees an entry — including the case where the user switches back to
// a session that already crashed while hidden.
//
// The listener is installed lazily on first registry use (alongside the
// unload cleanup) so test setups that don't construct the warm path
// don't get a phantom subscription. Idempotent — only one listener
// across the renderer's lifetime.
let exitUnsubscribe: (() => void) | null = null;
function installExitListenerOnce(): void {
  if (exitUnsubscribe) return;
  const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
  if (!pty?.onExit) return;
  exitUnsubscribe = pty.onExit(
    (evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => {
      const sid = evt.sessionId;
      if (!sid) return;
      try {
        // Pass code + signal through unchanged. The store slice's
        // `disconnectedSessions[sid].signal` field accepts
        // `string | number | null` — see `src/stores/slices/types.ts` —
        // so string signals ('SIGTERM' / 'SIGKILL' / etc.) flow through
        // to `classifyPtyExit` for the crashed-vs-clean overlay
        // distinction. Nullifying them here (as the prior fix did)
        // silently lost the diagnostic the legacy hook relied on.
        useStore.getState()._applyPtyExit(sid, {
          code: evt.code ?? null,
          signal: evt.signal ?? null,
        });
      } catch (e) {
        warn('xterm-warm', 'exit dispatch failed', e);
      }
    },
  );
}
// Module-level renderer-unload cleanup — fires once when the renderer
// unloads so addons release their canvas atlases / WebGL contexts
// cleanly. Best-effort only; the OS reclaims memory either way.
// Captured into a module-scope variable so `__resetRegistryForTests`
// can detach it on cleanup (Minor 7 from cold review) — a leftover
// listener across vitest re-imports would otherwise pile up
// disposed-entry references.
let beforeUnloadHandler: (() => void) | null = null;
function installUnloadCleanupOnce(): void {
  if (beforeUnloadHandler) return;
  if (typeof window === 'undefined') return;
  beforeUnloadHandler = () => {
    for (const sid of Array.from(warm.keys())) {
      disposeEntry(sid, 'unload');
    }
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

function getOffscreenHolder(): HTMLDivElement {
  if (offscreenHolder && offscreenHolder.isConnected) return offscreenHolder;
  offscreenHolder = document.createElement('div');
  offscreenHolder.setAttribute('data-ccsm-warm-offscreen', '');
  // visibility:hidden + zero size (NOT display:none) so any addon RAF
  // callback that queries the wrapper's metrics gets sensible zero values
  // rather than throwing. `fit()` is never invoked while parented here.
  offscreenHolder.style.cssText =
    'position:absolute;width:0;height:0;overflow:hidden;visibility:hidden;left:-9999px;top:-9999px;';
  document.body.appendChild(offscreenHolder);
  return offscreenHolder;
}

/** Number of warm entries currently held — primarily for probe payloads. */
export function getWarmCacheSize(): number {
  return warm.size;
}

/** Returns the entry registered for `sid`, or `undefined`. */
export function getEntry(sid: string): WarmEntry | undefined {
  return warm.get(sid);
}

/** Current foreground sid, or `null` if none has been shown yet. */
export function getActiveSid(): string | null {
  return activeSid;
}

/** Returns the foreground entry, or `undefined`. */
export function getActiveEntry(): WarmEntry | undefined {
  return activeSid != null ? warm.get(activeSid) : undefined;
}

/**
 * Construct a fresh xterm Terminal + addons for `sid`, allocate its DOM
 * wrapper, install the per-entry PTY data subscription, and insert into
 * the registry. Returns the new entry parented in the offscreen holder —
 * caller must subsequently call {@link showEntry} to make it visible.
 *
 * LRU evicts an existing entry if registry is at cap. Active sid and the
 * just-allocated sid are exempt.
 */
function allocEntry(sid: string): WarmEntry {
  installUnloadCleanupOnce();
  installExitListenerOnce();

  // LRU eviction: trim BEFORE allocating so we never exceed cap.
  const cap = getWarmCap();
  if (warm.size >= cap) {
    let oldestSid: string | null = null;
    let oldestAt = Infinity;
    for (const [otherSid, entry] of warm.entries()) {
      if (otherSid === sid) continue;
      if (otherSid === activeSid) continue;
      if (entry.lastAccessedAt < oldestAt) {
        oldestAt = entry.lastAccessedAt;
        oldestSid = otherSid;
      }
    }
    if (oldestSid) {
      disposeEntry(oldestSid, 'lru');
    }
  }

  const scrollback =
    useStore.getState().scrollbackLines ?? SCROLLBACK_LINES_DEFAULT;
  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: false,
    allowProposedApi: true,
    scrollback,
    theme: { background: '#000000' },
    scrollSensitivity: 0.5,
    fastScrollSensitivity: 5,
    fastScrollModifier: 'alt',
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  try {
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) {
          window.ccsm?.openExternal?.(uri);
        }
      }),
    );
  } catch (e) {
    warn('xterm-warm', 'web-links addon failed', e);
  }
  try {
    term.loadAddon(new ClipboardAddon());
  } catch (e) {
    warn('xterm-warm', 'clipboard addon failed', e);
  }
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch (e) {
    warn('xterm-warm', 'unicode11 addon failed', e);
  }
  try {
    term.loadAddon(new CanvasAddon());
  } catch (e) {
    warn('xterm-warm', 'canvas addon failed, falling back to DOM', e);
  }

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-ccsm-warm-sid', sid);
  wrapper.className = 'absolute inset-0';
  // Park under the offscreen holder until showEntry() reparents it.
  // NOTE: do NOT call `term.open(wrapper)` here — xterm 5.5's renderer
  // latches onto wrapper geometry at open() time, and the offscreen
  // holder is 0x0 / visibility:hidden, which leaves the paint scheduler
  // permanently quiesced. The first ensureAndShowEntry() calls open()
  // against the visible host instead.
  getOffscreenHolder().appendChild(wrapper);

  // Per-entry PTY data subscription. Filters by sid (NOT by the global
  // active sid) so hidden sessions keep ingesting live output. The bytes
  // are passed through to `term.write` unmodified — transparent transport.
  //
  // Routing modes (see EntryRouter docs above):
  //   - 'buffering' (default until applySnapshot): chunks accumulate in
  //     router.buffered with their seq. NOT written to term yet, because
  //     the cold-attach path is about to call term.reset() + write the
  //     snapshot; writing live chunks before then would be silently
  //     dropped by reset(). This is the Major 1 fix from cold review.
  //   - 'live': chunks with seq > router.snapSeq are written immediately;
  //     chunks <= snapSeq are dropped (already represented in the
  //     snapshot the cold path applied). Warm-cache hits stay in this
  //     mode for the entry's whole life — the first cold path flipped it.
  const router: EntryRouter = { mode: 'buffering', snapSeq: null, buffered: [] };
  entryRouters.set(sid, router);
  const pty = window.ccsmPty;
  let dataUnsubscribe = () => {};
  // One-shot probe flags — independent so a `sid-mismatch` first callback
  // doesn't suppress the subsequent `warm.data.received` probe. Under the
  // multi-subscriber pty.onData fan-out the first invocation is commonly
  // for someone else's sid; a shared flag would mislead future bisection.
  let receivedLogged = false;
  let filteredLogged = false;
  if (pty?.onData) {
    dataUnsubscribe = pty.onData((payload: { sid: string; chunk: string; seq: number }) => {
      if (payload.sid !== sid) {
        if (!filteredLogged) {
          // One-shot: the FIRST callback invocation that was filtered out
          // by sid mismatch. Tells us callback fires but our sid doesn't
          // match what main is broadcasting. count=0 sentinel.
          filteredLogged = true;
          try {
            log.event('warm.data.filtered', { sid, count: 0, stage: 'sid-mismatch' });
          } catch {
            /* probe failure tolerated */
          }
        }
        return;
      }
      if (!receivedLogged) {
        receivedLogged = true;
        try {
          log.event('warm.data.received', {
            sid,
            bytes: payload.chunk.length,
            count: 1,
            stage: router.mode,
          });
        } catch {
          /* probe failure tolerated */
        }
      }
      if (router.mode === 'buffering') {
        // Stash with seq so applySnapshot can drop dupes vs. the
        // serialized snapshot it's about to land. Soft cap: drop the
        // OLDEST entries past the cap so an unexpectedly long buffering
        // window (e.g. term.open() retry path never succeeding) can't
        // grow router.buffered unbounded. 256 chunks ≈ several seconds
        // of normal output; we hit applySnapshot well before this in
        // any healthy attach.
        router.buffered.push({ seq: payload.seq, chunk: payload.chunk });
        if (router.buffered.length > BUFFERING_SOFT_CAP) {
          router.buffered.shift();
        }
        return;
      }
      // 'live' mode: drop pre-snap chunks (defensive — should be empty
      // by here since applySnapshot drained them), write the rest.
      if (router.snapSeq != null && payload.seq <= router.snapSeq) return;
      // IME composition guard. While a CJK IME is composing, every
      // `term.write` reanchors the hidden textarea and makes the
      // composition preview box jump. Buffer chunks here and flush them
      // on `compositionend`. Read the entry's composing flag lazily so
      // listeners installed later (the composition listeners themselves
      // run in `ensureAndShowEntry`) can flip the bit without needing
      // their own write path.
      const entryNow = warm.get(sid);
      if (entryNow?.composing) {
        entryNow.bufferedDuringComposition.push(payload.chunk);
        entryNow.imeBufferedBytes += payload.chunk.length;
        return;
      }
      try {
        term.write(payload.chunk);
      } catch {
        // best-effort — term may have been disposed mid-flight.
      }
    });
  }

  const entry: WarmEntry = {
    sid,
    term,
    fit,
    wrapper,
    dataUnsubscribe,
    lastAccessedAt: Date.now(),
    opened: false,
    inputListenersInstalled: false,
    composing: false,
    bufferedDuringComposition: [],
    imeBufferedBytes: 0,
    imeUpdateCount: 0,
    imeCompositionStartedAt: 0,
    keyboardPasteHandled: false,
    inputDisposers: [],
  };
  warm.set(sid, entry);

  try {
    log.event('terminal.warmAlloc', { sid, lruSize: warm.size });
  } catch {
    /* probe failure must not break alloc */
  }

  return entry;
}

/**
 * Install all textarea-dependent input listeners for `entry`:
 *
 *   1. IME composition (compositionstart/update/end on `term.textarea`).
 *      Flips `entry.composing`; the `pty.onData` live-mode handler reads
 *      this flag and buffers chunks during composition windows so the
 *      hidden textarea doesn't get reanchored mid-edit (the CJK preview
 *      box would jump).
 *
 *   2. Custom key handler (`term.attachCustomKeyEventHandler`).
 *      Ctrl/Cmd+C copies selection (or falls through to SIGINT when no
 *      selection), Ctrl/Cmd+V pastes via the shared `paste` module,
 *      Ctrl/Cmd+A selects all. Shift variants force always-clipboard
 *      semantics matching Windows Terminal.
 *
 *   3. Selection-to-clipboard auto-copy (`term.onSelectionChange`).
 *      ttyd-style — Shift-drag in alt-screen apps (claude) copies the
 *      selection without an explicit Ctrl+C. Best-effort; clipboard
 *      failures are tolerated.
 *
 *   4. Capture-phase `paste` listener on `entry.wrapper`. Swallows
 *      xterm's built-in paste pipeline (which would call
 *      `triggerDataEvent` and bypass our bracketed-paste normalization)
 *      and routes through `pasteIntoActivePty`. The `keyboardPasteHandled`
 *      handoff flag suppresses the duplicate native paste event that
 *      some browsers/Electron versions dispatch after the keydown
 *      handler injects.
 *
 * MUST run AFTER `term.open()` succeeds — `term.textarea` is `undefined`
 * before then. Caller gates via `entry.opened` + `entry.inputListenersInstalled`.
 *
 * Every disposer registers on `entry.inputDisposers`; `disposeEntry`
 * drains them.
 */
function installInputListeners(entry: WarmEntry): void {
  const term = entry.term;
  const sid = entry.sid;
  const wrapper = entry.wrapper;
  const ta = term.textarea;

  // (1) IME composition listeners — only if textarea is present. Real
  // xterm always provides one post-open; tests may stub the Terminal
  // without one, in which case we skip silently (the composing flag
  // stays false and the live-mode write path is uninhibited).
  if (ta) {
    const onStart = () => {
      entry.composing = true;
      entry.bufferedDuringComposition.length = 0;
      entry.imeBufferedBytes = 0;
      entry.imeUpdateCount = 0;
      entry.imeCompositionStartedAt = Date.now();
      try {
        log.event('ime.composition.start', { sid });
      } catch {
        /* probe failure tolerated */
      }
    };
    const onUpdate = () => {
      entry.imeUpdateCount += 1;
      if (entry.imeUpdateCount % IME_UPDATE_SAMPLE_N === 0) {
        try {
          log.event('ime.composition.progress', {
            sid,
            count: entry.imeUpdateCount,
          });
        } catch {
          /* probe failure tolerated */
        }
      }
    };
    const onEnd = () => {
      entry.composing = false;
      const durationMs = entry.imeCompositionStartedAt
        ? Date.now() - entry.imeCompositionStartedAt
        : 0;
      const chunks = entry.bufferedDuringComposition.length;
      const bytes = entry.imeBufferedBytes;
      try {
        log.event('ime.composition.end', {
          sid,
          durationMs,
          bufferedChunks: chunks,
          bufferedBytes: bytes,
        });
      } catch {
        /* probe failure tolerated */
      }
      if (chunks > 0) {
        // Single coalesced flush — concatenate the buffered chunks and
        // write in one call so the parser sees the post-composition
        // tail as a contiguous batch.
        const pending = entry.bufferedDuringComposition.join('');
        entry.bufferedDuringComposition.length = 0;
        entry.imeBufferedBytes = 0;
        try {
          term.write(pending);
        } catch {
          /* best-effort */
        }
        try {
          log.event('ime.buffer.flush', { sid, bytes: pending.length, chunks });
        } catch {
          /* probe failure tolerated */
        }
      }
    };
    ta.addEventListener('compositionstart', onStart);
    ta.addEventListener('compositionupdate', onUpdate);
    ta.addEventListener('compositionend', onEnd);
    entry.inputDisposers.push(() => {
      try {
        ta.removeEventListener('compositionstart', onStart);
      } catch {
        /* ignore */
      }
      try {
        ta.removeEventListener('compositionupdate', onUpdate);
      } catch {
        /* ignore */
      }
      try {
        ta.removeEventListener('compositionend', onEnd);
      } catch {
        /* ignore */
      }
    });
  }

  // (2) Capture-phase paste listener — installs on the wrapper so it
  // intercepts paste before xterm's built-in pipeline runs. See the
  // `xtermSingleton.ts` history comment (PR ~v0.2.0/2.1) for the
  // single-canonical-paste rationale.
  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (entry.keyboardPasteHandled) {
      entry.keyboardPasteHandled = false;
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    try {
      log.event('paste.branch', { sid, branch: 'capture-dom' });
    } catch {
      /* probe failure tolerated */
    }
    void pasteIntoActivePty(() => entry.term, sid, text || undefined);
  };
  wrapper.addEventListener('paste', onPasteCapture, true);
  entry.inputDisposers.push(() => {
    try {
      wrapper.removeEventListener('paste', onPasteCapture, true);
    } catch {
      /* ignore */
    }
  });

  // (3) Selection-to-clipboard auto-copy. ttyd convention — works in
  // alt-screen apps when the user holds Shift to bypass mouse tracking.
  try {
    const selDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          /* ignore — selection still highlights */
        }
      }
    });
    entry.inputDisposers.push(() => {
      try {
        selDisposable?.dispose?.();
      } catch {
        /* ignore */
      }
    });
  } catch (e) {
    warn('xterm-warm', 'onSelectionChange attach failed', e);
  }

  // (4) Custom key handler — Ctrl/Cmd+C/V/A. Same matrix as the legacy
  // singleton path; reads selection state at keypress time so it tracks
  // live xterm state rather than a snapshot.
  const pasteFromClipboard = (): void => {
    entry.keyboardPasteHandled = true;
    // Reset on a macrotask (NOT a microtask). Browsers dispatch the
    // follow-up native `paste` AFTER our keydown returns but BEFORE the
    // next task tick — microtasks fire before that native paste, so a
    // microtask reset leaves the flag false when the capture listener
    // runs and we get a double-paste. setTimeout(0) lands AFTER the
    // native paste dispatch, so the capture listener sees the flag and
    // suppresses.
    setTimeout(() => {
      entry.keyboardPasteHandled = false;
    }, 0);
    let text: string | undefined;
    try {
      text = window.ccsmPty?.clipboard?.readText() || undefined;
    } catch {
      /* best-effort */
    }
    try {
      log.event('paste.branch', { sid, branch: 'ctrl-v' });
    } catch {
      /* probe failure tolerated */
    }
    void pasteIntoActivePty(() => entry.term, sid, text);
  };
  try {
    term.attachCustomKeyEventHandler((ev) => {
      if (ev.type !== 'keydown') return true;
      const mod = ev.ctrlKey || ev.metaKey;
      if (!mod || ev.altKey) return true;
      const isC = ev.key === 'C' || ev.key === 'c';
      const isV = ev.key === 'V' || ev.key === 'v';
      const isA = ev.key === 'A' || ev.key === 'a';

      if (!ev.shiftKey && isA) {
        try {
          term.selectAll();
        } catch {
          /* ignore */
        }
        return false;
      }
      if (!ev.shiftKey && isC) {
        const sel = term.getSelection();
        if (sel) {
          try {
            window.ccsmPty?.clipboard?.writeText(sel);
          } catch {
            /* ignore */
          }
          return false;
        }
        return true; // fall through to SIGINT
      }
      if (!ev.shiftKey && isV) {
        pasteFromClipboard();
        return false;
      }
      if (ev.shiftKey && isC) {
        const sel = term.getSelection();
        if (sel) {
          try {
            window.ccsmPty?.clipboard?.writeText(sel);
          } catch {
            /* ignore */
          }
        }
        return false;
      }
      if (ev.shiftKey && isV) {
        pasteFromClipboard();
        return false;
      }
      return true;
    });
  } catch (e) {
    warn('xterm-warm', 'attachCustomKeyEventHandler failed', e);
  }
  // (No disposer needed for the key handler — xterm overwrites on
  // subsequent attach calls; the entry's lifetime IS the handler's.)
}

/**
 * Ensure an entry exists for `sid`. Reparents its wrapper into `host` and
 * promotes it to active. Returns `{ entry, isCold }` — `isCold` is true
 * iff the entry was just allocated (caller should run cold-attach IPC).
 *
 * Side effects:
 *   1. Previously active entry's wrapper is reparented to the offscreen
 *      holder (a `terminal.warmHide` probe fires).
 *   2. New entry's wrapper is appended into `host`. `appendChild` moves
 *      the node when it already has a parent — this IS the reparent.
 *   3. `activeSid` is set to `sid`; `lastAccessedAt` is bumped.
 *   4. `window.__ccsmTerm` is repointed at the new entry's term so e2e
 *      probes always reach the foreground terminal.
 *   5. On first show after alloc: `term.open()` runs against the visible
 *      host, then textarea-dependent input listeners are installed.
 */
export function ensureAndShowEntry(
  sid: string,
  host: HTMLElement,
  cause: 'session-switch' | 'mount' | 'retry' = 'session-switch',
): { entry: WarmEntry; isCold: boolean } {
  // Hide previous active entry (reparent into offscreen holder).
  if (activeSid && activeSid !== sid) {
    const prev = warm.get(activeSid);
    if (prev) {
      try {
        getOffscreenHolder().appendChild(prev.wrapper);
      } catch (e) {
        warn('xterm-warm', 'hide reparent failed', e);
      }
      try {
        log.event('terminal.warmHide', { sid: activeSid, lruSize: warm.size });
      } catch {
        /* probe failure tolerated */
      }
    }
  }

  let entry = warm.get(sid);
  const isCold = !entry;
  if (!entry) {
    entry = allocEntry(sid);
  }

  // Reparent (or initial-parent) into the live host.
  try {
    host.appendChild(entry.wrapper);
  } catch (e) {
    warn('xterm-warm', 'show reparent failed', e);
  }

  // First-time open: deferred from allocEntry so the xterm renderer
  // initializes against real visible geometry rather than the 0x0
  // offscreen holder (see WarmEntry.opened docs). We do NOT call
  // fit.fit() here — host layout may not have settled on the same
  // microtask, and (cold path) usePtyAttach.warm.ts calls fit.fit()
  // after term.resize() + snapshot write a few ms later, which sizes
  // the canvas atlas against fully-laid-out dimensions. The eager fit
  // here would either redundantly force layout or compute cols=0 when
  // host itself is still hidden.
  if (!entry.opened) {
    try {
      entry.term.open(entry.wrapper);
      entry.opened = true;
    } catch (e) {
      warn('xterm-warm', 'term.open failed', e);
      // Leave entry.opened=false; a future show may retry.
    }
  }

  // Install textarea-dependent input listeners exactly once per entry,
  // AFTER `term.open()` has succeeded (term.textarea only exists from
  // that point). Subsequent shows skip via the `inputListenersInstalled`
  // flag. See `installInputListeners` for the full surface (IME
  // composition, custom key handler, capture-phase paste, selection
  // auto-copy).
  if (entry.opened && !entry.inputListenersInstalled) {
    installInputListeners(entry);
    entry.inputListenersInstalled = true;
  }

  entry.lastAccessedAt = Date.now();
  activeSid = sid;
  try {
    window.__ccsmTerm = entry.term;
  } catch {
    /* probe handle is best-effort */
  }

  if (!isCold) {
    // Warm path probe — fires only on cache hit. Cold path emits
    // `terminal.warmAlloc` from `allocEntry`. Includes viewport
    // diagnostics so the parent can verify the bottom-pin invariant
    // holds against the warm switch — same shape as the `attach.*`
    // family from PR #1352.
    try {
      const buf = entry.term.buffer?.active;
      log.event('attach.warm.shown', {
        sid,
        viewportY: buf?.viewportY ?? 0,
        baseY: buf?.baseY ?? 0,
        bufferType: buf?.type ?? 'normal',
        cursorY: buf?.cursorY ?? 0,
        length: buf?.length ?? 0,
        atBottom: (buf?.viewportY ?? 0) === (buf?.baseY ?? 0),
        warmCacheSize: warm.size,
        cause,
      });
    } catch {
      /* probe failure must not break show */
    }
  }

  return { entry, isCold };
}

/**
 * Cold-attach rendezvous (Major 1 fix from cold review).
 *
 * Called by the warm `usePtyAttach` hook AFTER it has:
 *   1. `await pty.attach(sid)`     (main starts broadcasting chunks)
 *   2. `await pty.getBufferSnapshot(sid)`   (gives us `{snapshot, seq}`)
 *   3. `entry.term.reset()` + `entry.term.write(snapshot)`
 *
 * At this point the per-entry data listener has been buffering live
 * chunks since alloc. We:
 *   a. Set `router.snapSeq = snapSeq` so future late chunks dedupe.
 *   b. Drain `router.buffered` — chunks with `seq > snapSeq` get
 *      written in arrival order; chunks `<= snapSeq` are already in
 *      the snapshot we just wrote and would duplicate.
 *   c. Flip `router.mode` to 'live'. Subsequent chunks bypass the
 *      buffer entirely and write straight to term.
 *
 * Idempotent if the router is missing (entry was disposed mid-attach).
 * Idempotent if mode is already 'live' (e.g. retry path re-calls into
 * a now-warm entry).
 */
export function applySnapshot(sid: string, snapSeq: number): void {
  const router = entryRouters.get(sid);
  if (!router) return;
  const entry = warm.get(sid);
  if (!entry) return;
  router.snapSeq = snapSeq;
  // Drain in arrival order. Chunks <= snapSeq are baked into the
  // snapshot the cold path just wrote — drop them. The rest is the
  // "live tail" that arrived between attach-resolve and snapshot-land.
  if (router.buffered.length > 0) {
    for (const b of router.buffered) {
      if (b.seq > snapSeq) {
        try {
          entry.term.write(b.chunk);
        } catch {
          // best-effort — term may have been disposed mid-drain.
        }
      }
    }
    router.buffered.length = 0;
  }
  router.mode = 'live';
}

/**
 * Tear down the entry for `sid`: unsubscribe PTY data, dispose the xterm
 * Terminal (which detaches all addons and frees the canvas atlas), remove
 * the wrapper from DOM, and drop the map entry. Emits
 * `terminal.warmEvict` with the supplied cause. Idempotent on unknown sid.
 *
 * The PTY-side `attach`/`detach` bookkeeping is the responsibility of the
 * attach hook, NOT this module. We only own the renderer's xterm.
 */
export function disposeEntry(
  sid: string,
  cause: 'lru' | 'session-deleted' | 'reset' | 'unload' | 'cancelled-mid-cold-attach',
): void {
  const entry = warm.get(sid);
  if (!entry) return;
  warm.delete(sid);
  // Drop the router so a future re-alloc for this sid starts fresh in
  // 'buffering' mode (Major 1) rather than inheriting a half-applied
  // snapSeq from the disposed entry.
  entryRouters.delete(sid);
  if (activeSid === sid) {
    activeSid = null;
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
  }
  try {
    entry.dataUnsubscribe();
  } catch (e) {
    warn('xterm-warm', 'dataUnsubscribe failed', e);
  }
  // Drain the input-side disposers (IME listeners, capture-paste,
  // selection-copy). The custom key handler has no disposer — xterm's
  // `attachCustomKeyEventHandler` is overwrite-on-set, and the entry's
  // Terminal is disposed below anyway.
  for (const d of entry.inputDisposers) {
    try {
      d();
    } catch (e) {
      warn('xterm-warm', 'inputDisposer failed', e);
    }
  }
  entry.inputDisposers.length = 0;
  try {
    entry.wrapper.remove();
  } catch (e) {
    warn('xterm-warm', 'wrapper.remove failed', e);
  }
  try {
    entry.term.dispose();
  } catch (e) {
    warn('xterm-warm', 'term.dispose failed', e);
  }
  try {
    log.event('terminal.warmEvict', { sid, lruSize: warm.size, cause });
  } catch {
    /* probe failure tolerated */
  }
}

/**
 * Test-only: drop all entries without emitting probes (tests don't want
 * probe noise polluting their own assertions). Also resets the
 * offscreen-holder pointer + the unload-listener flag so the next test
 * starts from a clean slate.
 */
export function __resetRegistryForTests(): void {
  for (const entry of warm.values()) {
    try {
      entry.dataUnsubscribe();
    } catch {
      /* ignore */
    }
    for (const d of entry.inputDisposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    entry.inputDisposers.length = 0;
    try {
      entry.wrapper.remove();
    } catch {
      /* ignore */
    }
    try {
      entry.term.dispose();
    } catch {
      /* ignore */
    }
  }
  warm.clear();
  entryRouters.clear();
  activeSid = null;
  if (offscreenHolder) {
    try {
      offscreenHolder.remove();
    } catch {
      /* ignore */
    }
  }
  offscreenHolder = null;
  // Detach the beforeunload listener — leaving it attached across vitest
  // re-imports leaks stale closures that reference disposed entries
  // (Minor 7 from cold review).
  if (beforeUnloadHandler && typeof window !== 'undefined') {
    try {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    } catch {
      /* ignore */
    }
  }
  beforeUnloadHandler = null;
  // Drop the global PTY exit subscription so the next test starts with
  // no listener (Major 2 fix). Without this, a stale subscription would
  // dispatch into the previous test's store stub.
  if (exitUnsubscribe) {
    try {
      exitUnsubscribe();
    } catch {
      /* ignore */
    }
  }
  exitUnsubscribe = null;
  if (typeof window !== 'undefined') {
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
  }
}
