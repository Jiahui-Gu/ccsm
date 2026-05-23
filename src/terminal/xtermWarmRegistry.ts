// Per-session warm xterm registry (PR #25 — architectural fix for the
// session-switch 冲顶 / scroll-to-top flash).
//
// Goal (user-stated): "我一个session本来是打开的, 我理解切到另一个session,
// 当前session只是被放在后台了, 就像图层一样, 被盖住了, 那切回来的时候只是简单
// 把他调到最上层." Translation: VS Code-style layer model — each session
// keeps its own xterm Terminal alive in memory; switching sessions is just
// reparenting a DOM wrapper, NOT rebuilding state.
//
// This module is GATED — it must only be activated when the
// `CCSM_WARM_XTERM=1` env flag is set (read at preload init, surfaced via
// `window.ccsm.featureFlags.warmXterm`). The legacy singleton
// (`./xtermSingleton.ts`) remains the default path. When the flag is off
// nothing in this file is imported.
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

const DEFAULT_WARM_CAP = 20;

/** Look up the runtime LRU cap. Honours `CCSM_WARM_XTERM_CAP` (surfaced via
 *  `window.ccsm.featureFlags.warmXtermCap`, clamped to [1,100] at preload).
 *  Falls back to {@link DEFAULT_WARM_CAP} when the override is absent. */
export function getWarmCap(): number {
  try {
    const override = window.ccsm?.featureFlags?.warmXtermCap;
    if (typeof override === 'number' && Number.isFinite(override) && override > 0) {
      return Math.min(100, Math.max(1, Math.floor(override)));
    }
  } catch {
    // window.ccsm absent in headless tests — fall through to default.
  }
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
};

const warm: Map<string, WarmEntry> = new Map();
let activeSid: string | null = null;
let offscreenHolder: HTMLDivElement | null = null;

// Module-level reset listener — fires once when the renderer unloads so
// addons release their canvas atlases / WebGL contexts cleanly. Best-effort
// only; the OS reclaims memory either way.
let beforeUnloadInstalled = false;
function installUnloadCleanupOnce(): void {
  if (beforeUnloadInstalled) return;
  if (typeof window === 'undefined') return;
  beforeUnloadInstalled = true;
  window.addEventListener('beforeunload', () => {
    for (const sid of Array.from(warm.keys())) {
      disposeEntry(sid, 'unload');
    }
  });
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
  getOffscreenHolder().appendChild(wrapper);
  term.open(wrapper);

  // Per-entry PTY data subscription. Filters by sid (NOT by the global
  // active sid) so hidden sessions keep ingesting live output. The bytes
  // are passed through to `term.write` unmodified — transparent transport.
  const pty = window.ccsmPty;
  let dataUnsubscribe = () => {};
  if (pty?.onData) {
    dataUnsubscribe = pty.onData((payload: { sid: string; chunk: string }) => {
      if (payload.sid !== sid) return;
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
  cause: 'lru' | 'session-deleted' | 'reset' | 'unload',
): void {
  const entry = warm.get(sid);
  if (!entry) return;
  warm.delete(sid);
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
  activeSid = null;
  if (offscreenHolder) {
    try {
      offscreenHolder.remove();
    } catch {
      /* ignore */
    }
  }
  offscreenHolder = null;
  beforeUnloadInstalled = false;
  if (typeof window !== 'undefined') {
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
  }
}
