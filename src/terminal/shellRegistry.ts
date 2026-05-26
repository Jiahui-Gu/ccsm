// Per-session shell registry — implements the attach UX model defined in
// `docs/attach-redesign.html` (design doc, source of truth).
//
// Two rules, period:
//   1. First click on a session = COLD START. Right pane shows a "preparing"
//      mask. Behind the mask we build the shell (subscribe PTY, build xterm,
//      pull snapshot, write, scrollToBottom). Mask comes down only when
//      everything is done — the user never sees a half-built terminal.
//   2. Click on a session we've already seen = INSTANT SWITCH. z-stack
//      flips the matching wrapper to the top (`display:''` + `z-index`);
//      every other wrapper goes `display:none`. xterm instances NEVER
//      reparent. Viewport stays where the user left it. No mask, no IPC,
//      no rebuild.
//
// Sessions that were never clicked are NOT prepared. We don't subscribe
// their PTY, we don't build their xterm, we hold zero resources for them.
// The sidebar is just a list.
//
// Once a session has been clicked we keep its shell alive until the
// renderer unloads (`disposeAll`). No LRU, no eviction, no cap — per
// explicit manager direction. A single user's daily session count is
// orders of magnitude below the memory pressure line, and overengineering
// the cache here was the whole class of bugs the prior `xtermWarmRegistry`
// design produced.
//
// The xterm instance and its wrapper NEVER reparent after the first
// `term.open(wrapper)`. Switching is a `style.display` + `style.zIndex`
// toggle on a stable parent host. This is the only way webkit doesn't
// drop `.xterm-viewport.scrollTop` across hide/show (bug #69 / PR #1374).
//
// Transparent-transport invariant: PTY bytes pass through `term.write`
// untouched. No chunking / throttling / rewriting at this layer.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import { useStore } from '../stores/store';
import {
  SCROLLBACK_LINES_DEFAULT,
  TERMINAL_FONT_SIZE_DEFAULT,
} from '../stores/slices/types';
import { warn, log } from '../shared/log';
import { pasteIntoActivePty } from './paste';

/** `compositionupdate` log throttle — one event every Nth update. */
const IME_UPDATE_SAMPLE_N = 10;

/** Soft cap on the buffering window between alloc and snapshot apply. */
const BUFFERING_SOFT_CAP = 256;

/** z-index for the currently-shown shell. All others get 0. The exact
 *  value doesn't matter (the only thing competing for stacking inside the
 *  host is other shell wrappers), it just needs to be > 0 so we can
 *  un-stack by writing 0. */
const ACTIVE_Z_INDEX = 1;

export type ShellState =
  | { kind: 'cold-starting' }
  | { kind: 'ready' }
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

export type Shell = {
  sid: string;
  term: Terminal;
  fit: FitAddon;
  /** DOM wrapper containing the xterm canvases. Long-lived child of
   *  `host` once parented; never reparents. */
  wrapper: HTMLDivElement;
  /** Per-sid PTY chunk subscription. Live for the wrapper's whole life.
   *  Disposed only on `disposeAll` (renderer unload). */
  dataUnsubscribe: () => void;
  /** Disposers for input-side listeners (IME composition, capture-paste,
   *  selection-copy). Drained on dispose. */
  inputDisposers: Array<() => void>;
  /** Whether `term.open(wrapper)` has been called. */
  opened: boolean;
  /** IME composition state. While `composing` is true, live chunks
   *  buffer to `bufferedDuringComposition` and flush on compositionend. */
  composing: boolean;
  bufferedDuringComposition: string[];
  imeBufferedBytes: number;
  imeUpdateCount: number;
  imeCompositionStartedAt: number;
  /** Hand-off between Ctrl/Cmd+V keydown and the capture-phase paste
   *  listener; prevents double-paste. */
  keyboardPasteHandled: boolean;
  /** Pending font-size to apply on next show (set by applyFontSize on
   *  non-active shells). Null = entry's term.options.fontSize is current. */
  pendingFontSize: number | null;
};

/**
 * Per-shell PTY chunk routing state.
 *
 * The per-sid `pty.onData` subscription is installed BEFORE we call
 * `pty.attach` (in `createShell`). Between that subscription point and
 * the moment we land the snapshot, chunks are accumulated in `buffered`
 * with their seq — NOT written to term yet. Once the cold path has called
 * `term.write(snapshot)`, it calls `applySnapshot(sid, snap.seq)`:
 *   - chunks with seq > snapSeq are written in arrival order (the live
 *     tail that arrived between attach-resolve and snapshot-land)
 *   - chunks with seq <= snapSeq are dropped (already baked into the
 *     snapshot)
 *   - mode flips to 'live' and future chunks bypass the buffer.
 *
 * This is identical in spirit to the legacy registry's EntryRouter —
 * snapshot-vs-live-tail dedupe is non-negotiable for correctness.
 */
type ChunkRouter = {
  mode: 'buffering' | 'live';
  snapSeq: number | null;
  buffered: Array<{ seq: number; chunk: string }>;
};

const shells: Map<string, Shell> = new Map();
const routers: Map<string, ChunkRouter> = new Map();
let activeSid: string | null = null;

// Single module-level PTY exit subscription. Fans every exit (including
// for backgrounded sessions) into the store's `_applyPtyExit` slice so
// the attach hook can render the exit overlay on switch-back.
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
        useStore.getState()._applyPtyExit(sid, {
          code: evt.code ?? null,
          signal: evt.signal ?? null,
        });
      } catch (e) {
        warn('shell-registry', 'exit dispatch failed', e);
      }
    },
  );
}

let beforeUnloadHandler: (() => void) | null = null;
function installUnloadCleanupOnce(): void {
  if (beforeUnloadHandler) return;
  if (typeof window === 'undefined') return;
  beforeUnloadHandler = () => {
    disposeAll();
  };
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

/** Returns the shell for `sid` if it has been created, else null. */
export function getShell(sid: string): Shell | null {
  return shells.get(sid) ?? null;
}

/** Currently-foregrounded sid, or null. */
export function getActiveSid(): string | null {
  return activeSid;
}

/** Currently-foregrounded shell, or null. */
export function getActiveShell(): Shell | null {
  return activeSid != null ? shells.get(activeSid) ?? null : null;
}

/** Number of created shells. Primarily for probes / tests. */
export function getShellCount(): number {
  return shells.size;
}

/**
 * Subscribe to live chunks for `sid` and install the chunk router.
 * Returns the unsubscribe function. The listener writes to `term` only
 * when the router is in 'live' mode and the chunk's seq is past
 * `snapSeq`; while in 'buffering' mode chunks accumulate with their seq.
 *
 * Called exactly once per shell, during `createShell`. The subscription
 * is held for the shell's whole life — there is no `pty.detach` on
 * session-switch by design (that's the whole point of "look, switch
 * back, see the latest output already there").
 */
function installChunkRouter(sid: string, term: Terminal): () => void {
  const router: ChunkRouter = { mode: 'buffering', snapSeq: null, buffered: [] };
  routers.set(sid, router);
  const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
  if (!pty?.onData) return () => {};

  let receivedLogged = false;
  let filteredLogged = false;

  return pty.onData((payload: { sid: string; chunk: string; seq: number }) => {
    if (payload.sid !== sid) {
      if (!filteredLogged) {
        filteredLogged = true;
        try {
          log.event('shell.data.filtered', { sid, stage: 'sid-mismatch' });
        } catch {
          /* probe failure tolerated */
        }
      }
      return;
    }
    if (!receivedLogged) {
      receivedLogged = true;
      try {
        log.event('shell.data.received', {
          sid,
          bytes: payload.chunk.length,
          stage: router.mode,
        });
      } catch {
        /* probe failure tolerated */
      }
    }
    if (router.mode === 'buffering') {
      router.buffered.push({ seq: payload.seq, chunk: payload.chunk });
      if (router.buffered.length > BUFFERING_SOFT_CAP) {
        router.buffered.shift();
      }
      return;
    }
    if (router.snapSeq != null && payload.seq <= router.snapSeq) return;
    // IME composition guard — same logic as before, just lives here now.
    const cur = shells.get(sid);
    if (cur?.composing) {
      cur.bufferedDuringComposition.push(payload.chunk);
      cur.imeBufferedBytes += payload.chunk.length;
      return;
    }
    try {
      term.write(payload.chunk);
    } catch {
      /* best-effort — term may be disposed mid-flight */
    }
  });
}

/**
 * Cold-attach rendezvous: caller has written the snapshot into term.
 * Drain any buffered chunks with seq > snapSeq, drop the rest, flip the
 * router to live mode. Idempotent.
 *
 * Exported so the cold path can call it after writing the snapshot.
 */
export function applySnapshot(sid: string, snapSeq: number): void {
  const router = routers.get(sid);
  const shell = shells.get(sid);
  if (!router || !shell) return;
  router.snapSeq = snapSeq;
  if (router.buffered.length > 0) {
    for (const b of router.buffered) {
      if (b.seq > snapSeq) {
        try {
          shell.term.write(b.chunk);
        } catch {
          /* best-effort */
        }
      }
    }
    router.buffered.length = 0;
  }
  router.mode = 'live';
}

/**
 * Install all textarea-dependent listeners on `shell`:
 *   - IME composition (compositionstart/update/end)
 *   - Custom key handler (Ctrl/Cmd+C/V/A)
 *   - Capture-phase paste listener on the wrapper
 *   - Selection-to-clipboard auto-copy
 *
 * MUST be called after `term.open()` (textarea doesn't exist before then).
 */
function installInputListeners(shell: Shell): void {
  const { term, sid, wrapper } = shell;
  const ta = term.textarea;

  if (ta) {
    const onStart = () => {
      shell.composing = true;
      shell.bufferedDuringComposition.length = 0;
      shell.imeBufferedBytes = 0;
      shell.imeUpdateCount = 0;
      shell.imeCompositionStartedAt = Date.now();
      try {
        log.event('ime.composition.start', { sid });
      } catch {
        /* probe failure tolerated */
      }
    };
    const onUpdate = () => {
      shell.imeUpdateCount += 1;
      if (shell.imeUpdateCount % IME_UPDATE_SAMPLE_N === 0) {
        try {
          log.event('ime.composition.progress', {
            sid,
            count: shell.imeUpdateCount,
          });
        } catch {
          /* probe failure tolerated */
        }
      }
    };
    const onEnd = () => {
      shell.composing = false;
      const durationMs = shell.imeCompositionStartedAt
        ? Date.now() - shell.imeCompositionStartedAt
        : 0;
      const chunks = shell.bufferedDuringComposition.length;
      const bytes = shell.imeBufferedBytes;
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
        const pending = shell.bufferedDuringComposition.join('');
        shell.bufferedDuringComposition.length = 0;
        shell.imeBufferedBytes = 0;
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
    shell.inputDisposers.push(() => {
      try { ta.removeEventListener('compositionstart', onStart); } catch { /* ignore */ }
      try { ta.removeEventListener('compositionupdate', onUpdate); } catch { /* ignore */ }
      try { ta.removeEventListener('compositionend', onEnd); } catch { /* ignore */ }
    });
  }

  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (shell.keyboardPasteHandled) {
      shell.keyboardPasteHandled = false;
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
    try {
      log.event('paste.branch', { sid, branch: 'capture-dom' });
    } catch {
      /* probe failure tolerated */
    }
    void pasteIntoActivePty(() => shell.term, sid, text || undefined);
  };
  wrapper.addEventListener('paste', onPasteCapture, true);
  shell.inputDisposers.push(() => {
    try {
      wrapper.removeEventListener('paste', onPasteCapture, true);
    } catch {
      /* ignore */
    }
  });

  try {
    const selDisposable = term.onSelectionChange(() => {
      const sel = term.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          /* ignore */
        }
      }
    });
    shell.inputDisposers.push(() => {
      try {
        selDisposable?.dispose?.();
      } catch {
        /* ignore */
      }
    });
  } catch (e) {
    warn('shell-registry', 'onSelectionChange attach failed', e);
  }

  const pasteFromClipboard = (): void => {
    shell.keyboardPasteHandled = true;
    setTimeout(() => {
      shell.keyboardPasteHandled = false;
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
    void pasteIntoActivePty(() => shell.term, sid, text);
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
        try { term.selectAll(); } catch { /* ignore */ }
        return false;
      }
      if (!ev.shiftKey && isC) {
        const sel = term.getSelection();
        if (sel) {
          try { window.ccsmPty?.clipboard?.writeText(sel); } catch { /* ignore */ }
          return false;
        }
        return true;
      }
      if (!ev.shiftKey && isV) {
        pasteFromClipboard();
        return false;
      }
      if (ev.shiftKey && isC) {
        const sel = term.getSelection();
        if (sel) {
          try { window.ccsmPty?.clipboard?.writeText(sel); } catch { /* ignore */ }
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
    warn('shell-registry', 'attachCustomKeyEventHandler failed', e);
  }
}

/** Construct a fresh xterm Terminal + addons + wrapper for `sid`. The
 *  wrapper is appended to `host` but starts at `display:none` + `z-index:0`
 *  (off the top of the stack); the chunk router is installed in
 *  'buffering' mode so live chunks accumulate while the cold path runs. */
function allocShell(sid: string, host: HTMLElement): Shell {
  installUnloadCleanupOnce();
  installExitListenerOnce();

  const scrollback =
    useStore.getState().scrollbackLines ?? SCROLLBACK_LINES_DEFAULT;
  const fontSize =
    useStore.getState().terminalFontSizePx ?? TERMINAL_FONT_SIZE_DEFAULT;

  const term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize,
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
    warn('shell-registry', 'web-links addon failed', e);
  }
  try { term.loadAddon(new ClipboardAddon()); } catch (e) { warn('shell-registry', 'clipboard addon failed', e); }
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch (e) {
    warn('shell-registry', 'unicode11 addon failed', e);
  }
  try { term.loadAddon(new CanvasAddon()); } catch (e) { warn('shell-registry', 'canvas addon failed, falling back to DOM', e); }

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-ccsm-shell-sid', sid);
  wrapper.className = 'absolute inset-0';
  wrapper.style.display = 'none';
  wrapper.style.zIndex = '0';
  // Parent under host immediately so xterm's renderer initializes against
  // a real layout-tree node (offscreen-holder parking is what produced
  // the bug #69 first-frame flash class of issues).
  try {
    host.appendChild(wrapper);
  } catch (e) {
    warn('shell-registry', 'host.appendChild failed', e);
  }

  const dataUnsubscribe = installChunkRouter(sid, term);

  const shell: Shell = {
    sid,
    term,
    fit,
    wrapper,
    dataUnsubscribe,
    inputDisposers: [],
    opened: false,
    composing: false,
    bufferedDuringComposition: [],
    imeBufferedBytes: 0,
    imeUpdateCount: 0,
    imeCompositionStartedAt: 0,
    keyboardPasteHandled: false,
    pendingFontSize: null,
  };
  shells.set(sid, shell);

  try {
    log.event('shell.alloc', { sid, shellCount: shells.size });
  } catch {
    /* probe failure must not break alloc */
  }
  return shell;
}

/**
 * Show `sid`'s shell. PURE DOM: flip its wrapper to `display:''` +
 * `z-index: ACTIVE_Z_INDEX`, flip every other shell's wrapper to
 * `display:none` + `z-index: 0`. No `await`, no IPC. Sub-frame on a
 * modern machine — the whole point of "click already-seen session = fast".
 *
 * `__ccsmTerm` is repointed to the new active terminal so e2e probes
 * always reach the foregrounded one.
 *
 * Returns the shell that was shown, or null if no shell exists for sid
 * (caller should call `createShell` instead).
 */
export function showShell(sid: string): Shell | null {
  const target = shells.get(sid);
  if (!target) return null;
  for (const [otherSid, shell] of shells.entries()) {
    if (otherSid === sid) {
      try {
        shell.wrapper.style.display = '';
        shell.wrapper.style.zIndex = String(ACTIVE_Z_INDEX);
      } catch (e) {
        warn('shell-registry', 'show display flip failed', e);
      }
    } else {
      try {
        shell.wrapper.style.display = 'none';
        shell.wrapper.style.zIndex = '0';
      } catch (e) {
        warn('shell-registry', 'hide display flip failed', e);
      }
    }
  }
  activeSid = sid;
  try {
    window.__ccsmTerm = target.term;
  } catch {
    /* probe handle is best-effort */
  }
  // Lazy-apply pending font size from a Ctrl+wheel zoom that landed
  // while this shell was hidden. Reflow-only path (no snapshot replay).
  if (target.pendingFontSize != null) {
    const px = target.pendingFontSize;
    const cur = (target.term.options as { fontSize?: number }).fontSize;
    target.pendingFontSize = null;
    if (cur !== px) {
      try { target.term.options.fontSize = px; } catch (e) { warn('shell-registry', 'lazy fontSize failed', e); }
      try { target.fit.fit(); } catch (e) { warn('shell-registry', 'lazy fit failed', e); }
      try {
        const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
        const p = pty?.resize(sid, target.term.cols, target.term.rows);
        if (p && typeof (p as Promise<void>).then === 'function') {
          void (p as Promise<void>).catch((e) =>
            warn('shell-registry', 'lazy pty.resize failed', e),
          );
        }
      } catch (e) {
        warn('shell-registry', 'lazy pty.resize threw', e);
      }
    }
  }
  try {
    const buf = target.term.buffer?.active;
    log.event('shell.shown', {
      sid,
      viewportY: buf?.viewportY ?? 0,
      baseY: buf?.baseY ?? 0,
      bufferType: buf?.type ?? 'normal',
      cursorY: buf?.cursorY ?? 0,
      length: buf?.length ?? 0,
      atBottom: (buf?.viewportY ?? 0) === (buf?.baseY ?? 0),
      shellCount: shells.size,
    });
  } catch {
    /* probe failure tolerated */
  }
  return target;
}

/**
 * Cold start: build a shell for `sid` under `host`, run the full attach
 * pipeline (subscribe → attach → snapshot → write → scrollToBottom)
 * while a "preparing" mask covers the host, then reveal.
 *
 * The mask is a DOM div the CALLER owns (via the `mask` parameter — a
 * function that toggles its visibility). We don't reach into the host's
 * children to find one; the React component (TerminalPane) renders it
 * and hands us a controller. The shell itself is built under the same
 * host as a SIBLING of the mask, and is hidden + z=0 throughout the
 * cold-start window — when we finally call `showShell` at the end, the
 * caller flips the mask off in the same frame (the returned Promise's
 * resolution).
 *
 * `cwd` is used only when we need to call `pty.spawn` (attach returned
 * null — fresh sid, no pty yet). Existing PTYs ignore it.
 *
 * The returned Promise resolves to the final shell state (`ready` or
 * `error`). The caller decides what to do with `error`.
 */
export async function createShell(
  sid: string,
  host: HTMLElement,
  cwd: string,
  forkSourceSid?: string,
): Promise<ShellState> {
  if (shells.has(sid)) {
    // Idempotent — if a concurrent click landed two createShell calls for
    // the same sid, just show the existing one.
    showShell(sid);
    return { kind: 'ready' };
  }
  const startedAt = Date.now();
  const shell = allocShell(sid, host);
  // Make sure the shell stays hidden + below the mask during cold start.
  shell.wrapper.style.display = 'none';
  shell.wrapper.style.zIndex = '0';

  const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
  if (!pty) {
    return { kind: 'error', message: 'ccsmPty unavailable' };
  }

  try {
    let res = (await pty.attach(sid)) as
      | { cols: number; rows: number; pid: number }
      | null;
    if (!res) {
      const spawnResult = (await pty.spawn(sid, cwd ?? '', forkSourceSid)) as
        | { ok: true; sid: string; pid: number; cols: number; rows: number }
        | { ok: false; error: string };
      if (!spawnResult || spawnResult.ok === false) {
        const reason =
          spawnResult && spawnResult.ok === false ? spawnResult.error : 'spawn_failed';
        throw new Error(reason);
      }
      res = (await pty.attach(sid)) as
        | { cols: number; rows: number; pid: number }
        | null;
      if (!res) throw new Error('attach_failed_after_spawn');
    }
    const { cols, rows } = res;

    // Open xterm against the wrapper. The wrapper is parented under host
    // and `display:none` — xterm's renderer will pick up real geometry on
    // first `fit()` after we reveal. We open NOW so all the term internals
    // (textarea, canvas atlases) exist for the subsequent writes.
    //
    // Trick to make open() succeed with display:none: temporarily flip
    // visibility to hidden via `visibility:hidden` instead of display:none.
    // Actually — xterm 5.5 tolerates display:none at open() time; the
    // renderer just stays quiesced until the first paint after the
    // wrapper becomes visible. But cell metrics (cols/rows derived from
    // pixel-width) need real layout. We swap to `visibility:hidden` for
    // the open + fit + write window so layout is valid but the user
    // doesn't see the half-painted state (the mask is on top anyway).
    shell.wrapper.style.display = '';
    shell.wrapper.style.visibility = 'hidden';
    shell.wrapper.style.zIndex = '0';
    try {
      shell.term.open(shell.wrapper);
      shell.opened = true;
    } catch (e) {
      warn('shell-registry', 'term.open failed', e);
    }
    if (shell.opened) {
      installInputListeners(shell);
    }

    // Resize to PTY dims first so the snapshot cell grid matches.
    try {
      shell.term.resize(cols, rows);
    } catch {
      /* resize best-effort */
    }

    const snap = (await pty.getBufferSnapshot(sid)) as {
      snapshot: string;
      seq: number;
    };

    // Reset is purely defensive — nothing has been written yet (router
    // was in buffering mode, accumulating chunks but not writing).
    try {
      shell.term.reset();
    } catch {
      /* reset best-effort */
    }
    if (snap.snapshot) {
      await new Promise<void>((resolve) => {
        try {
          shell.term.write(snap.snapshot, () => resolve());
        } catch {
          resolve();
        }
      });
    }
    applySnapshot(sid, snap.seq);

    // Wire onData → pty.input. Only fires while this shell is active
    // (focus follows visibility — hidden xterms don't take keystrokes).
    const inputDisposable = shell.term.onData((data: string) => {
      if (getActiveSid() === sid) {
        window.ccsmPty.input(sid, data);
      }
    });
    shell.inputDisposers.push(() => {
      try { inputDisposable.dispose(); } catch { /* ignore */ }
    });

    // Post-write fit to size the canvas atlas against host dims. Push the
    // post-fit cols/rows to the PTY if they differ from spawn dims.
    try {
      shell.fit.fit();
      const newCols = shell.term.cols;
      const newRows = shell.term.rows;
      if (newCols !== cols || newRows !== rows) {
        try {
          await pty.resize(sid, newCols, newRows);
        } catch (e) {
          warn('shell-registry', 'post-attach pty.resize failed', e);
        }
      }
    } catch (e) {
      warn('shell-registry', 'post-attach fit failed', e);
    }

    // Pin viewport to bottom (resume sessions arrive with content ending
    // mid-buffer; we want the user to see the live prompt on reveal).
    await new Promise<void>((resolve) => {
      try {
        shell.term.write('', () => resolve());
      } catch {
        resolve();
      }
    });
    try {
      shell.term.scrollToBottom();
    } catch {
      /* best-effort */
    }
    try { shell.term.focus(); } catch { /* focus best-effort */ }

    // Reveal. Visibility flips back, z-index lifts via showShell.
    shell.wrapper.style.visibility = '';
    showShell(sid);

    try {
      log.event('shell.coldStart.complete', {
        sid,
        durationMs: Date.now() - startedAt,
        snapshotBytes: snap.snapshot?.length ?? 0,
        cols: shell.term.cols,
        rows: shell.term.rows,
      });
    } catch {
      /* probe failure tolerated */
    }

    // Race fix: if the PTY exited while we were in this async chain,
    // surface `exit` rather than `ready` so the overlay shows immediately.
    const exitInfo = useStore.getState().disconnectedSessions[sid];
    if (exitInfo) {
      const detail =
        exitInfo.signal != null
          ? `signal ${exitInfo.signal}`
          : exitInfo.code != null
            ? `exit code ${exitInfo.code}`
            : 'unknown';
      return { kind: 'exit', exitKind: exitInfo.kind, detail };
    }
    return { kind: 'ready' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { kind: 'error', message };
  }
}

/**
 * Refit + snapshot-replay for `sid`. Used by the host-resize observer:
 * splitter drag / window resize / fullscreen toggle changes the host's
 * dimensions, claude's alt-screen TUI won't repaint until next input, so
 * we pull a fresh snapshot and replay.
 */
export async function resizeReplay(sid: string): Promise<void> {
  const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
  const shell = shells.get(sid);
  if (!pty || !shell || !shell.opened) return;

  let wasAtBottom = true;
  let savedViewportY = 0;
  try {
    const buf = shell.term.buffer.active;
    wasAtBottom = buf.baseY - buf.viewportY <= 1;
    savedViewportY = buf.viewportY;
  } catch {
    /* default: assume at-bottom */
  }
  try {
    shell.fit.fit();
  } catch (e) {
    warn('shell-registry', 'resize fit failed', e);
    return;
  }
  const cols = shell.term.cols;
  const rows = shell.term.rows;
  try {
    const p = pty.resize(sid, cols, rows);
    if (p && typeof (p as Promise<void>).then === 'function') {
      await (p as Promise<void>);
    }
  } catch (e) {
    warn('shell-registry', 'resize pty.resize failed', e);
  }
  let snap: { snapshot: string; seq: number };
  try {
    snap = (await pty.getBufferSnapshot(sid)) as { snapshot: string; seq: number };
  } catch (e) {
    warn('shell-registry', 'resize snapshot fetch failed', e);
    return;
  }
  const cur = shells.get(sid);
  if (!cur || !cur.opened) return;
  try { cur.term.reset(); } catch (e) { warn('shell-registry', 'resize reset failed', e); }
  if (snap.snapshot) {
    await new Promise<void>((resolve) => {
      try {
        cur.term.write(snap.snapshot, () => resolve());
      } catch {
        resolve();
      }
    });
  }
  applySnapshot(sid, snap.seq);
  await new Promise<void>((resolve) => {
    try { cur.term.write('', () => resolve()); } catch { resolve(); }
  });
  try {
    if (wasAtBottom) {
      cur.term.scrollToBottom();
    } else {
      (cur.term as unknown as { scrollToLine?: (n: number) => void }).scrollToLine?.(savedViewportY);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Apply a new global xterm font size.
 *
 * Active shell: applied + reflow + pty.resize immediately. IME guard —
 * defer if mid-composition (changing fontSize reanchors the hidden
 * textarea, makes the preview jump).
 *
 * Inactive shells: mark `pendingFontSize`, applied lazily by showShell.
 */
export async function applyFontSize(px: number): Promise<void> {
  const active = getActiveShell();
  for (const [sid, shell] of shells.entries()) {
    if (active && sid === active.sid) continue;
    const cur = (shell.term.options as { fontSize?: number }).fontSize;
    if (cur === px) {
      shell.pendingFontSize = null;
    } else {
      shell.pendingFontSize = px;
    }
  }
  if (!active) return;
  if (active.composing) {
    active.pendingFontSize = px;
    return;
  }
  try {
    const cur = (active.term.options as { fontSize?: number }).fontSize;
    if (cur === px) {
      active.pendingFontSize = null;
      return;
    }
    active.term.options.fontSize = px;
    active.pendingFontSize = null;
  } catch (e) {
    warn('shell-registry', 'apply fontSize failed', e);
    return;
  }
  try {
    active.fit.fit();
  } catch (e) {
    warn('shell-registry', 'apply fontSize fit failed', e);
    return;
  }
  try {
    const pty = typeof window !== 'undefined' ? window.ccsmPty : undefined;
    if (!pty) return;
    const p = pty.resize(active.sid, active.term.cols, active.term.rows);
    if (p && typeof (p as Promise<void>).then === 'function') {
      await (p as Promise<void>);
    }
  } catch (e) {
    warn('shell-registry', 'apply fontSize pty.resize failed', e);
  }
}

/** Apply a new scrollback cap to every shell. Pure option write — xterm
 *  handles cap shrink (trim oldest) and cap grow (no-op until new writes)
 *  internally. */
export function applyScrollback(n: number): void {
  for (const shell of shells.values()) {
    try {
      const cur = (shell.term.options as { scrollback?: number }).scrollback;
      if (cur === n) continue;
      shell.term.options.scrollback = n;
    } catch (e) {
      warn('shell-registry', 'apply scrollback failed', e);
    }
  }
}

/** Dispose a single shell. Used by `reloadSession` (the renderer killed
 *  the PTY for this sid; the shell needs to go so the next click rebuilds
 *  from scratch). NOT called on session-switch — that's the entire point
 *  of "kept til renderer unloads". */
export function disposeShell(sid: string, cause: 'reload' | 'session-deleted' | 'retry'): void {
  const shell = shells.get(sid);
  if (!shell) return;
  shells.delete(sid);
  routers.delete(sid);
  if (activeSid === sid) {
    activeSid = null;
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
  }
  try { shell.dataUnsubscribe(); } catch (e) { warn('shell-registry', 'dataUnsubscribe failed', e); }
  for (const d of shell.inputDisposers) {
    try { d(); } catch (e) { warn('shell-registry', 'inputDisposer failed', e); }
  }
  shell.inputDisposers.length = 0;
  try { shell.wrapper.remove(); } catch (e) { warn('shell-registry', 'wrapper.remove failed', e); }
  try { shell.term.dispose(); } catch (e) { warn('shell-registry', 'term.dispose failed', e); }
  try {
    log.event('shell.dispose', { sid, cause, shellCount: shells.size });
  } catch {
    /* probe failure tolerated */
  }
}

/** Dispose every shell. Used by the beforeunload handler — when the
 *  renderer is shutting down, we tear down all xterms / canvas atlases /
 *  PTY subscriptions cleanly. */
export function disposeAll(): void {
  for (const sid of Array.from(shells.keys())) {
    disposeShell(sid, 'reload');
  }
}

/** Test-only: drop all shells without emitting probes. */
export function __resetRegistryForTests(): void {
  for (const shell of shells.values()) {
    try { shell.dataUnsubscribe(); } catch { /* ignore */ }
    for (const d of shell.inputDisposers) {
      try { d(); } catch { /* ignore */ }
    }
    shell.inputDisposers.length = 0;
    try { shell.wrapper.remove(); } catch { /* ignore */ }
    try { shell.term.dispose(); } catch { /* ignore */ }
  }
  shells.clear();
  routers.clear();
  activeSid = null;
  if (beforeUnloadHandler && typeof window !== 'undefined') {
    try { window.removeEventListener('beforeunload', beforeUnloadHandler); } catch { /* ignore */ }
  }
  beforeUnloadHandler = null;
  if (exitUnsubscribe) {
    try { exitUnsubscribe(); } catch { /* ignore */ }
  }
  exitUnsubscribe = null;
  if (typeof window !== 'undefined') {
    try { delete window.__ccsmTerm; } catch { /* ignore */ }
  }
}
