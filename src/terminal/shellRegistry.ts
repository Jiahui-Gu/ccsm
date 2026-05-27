// `shellRegistry` — the only renderer-side terminal lifecycle module post
// attach-redesign (see `docs/attach-redesign.html`).
//
// Mental model (3 UX states from the design doc):
//   State 0 — App just opened. No shells exist. Right pane is black.
//   State 1 — Cold start. A wrapper appears in the host, mask covers it
//             while we fetch snapshot + build xterm + subscribe to PTY.
//             Mask removed once content is on screen.
//   State 2 — Already-visited switch. Wrappers stay parented in the host;
//             switching is a z-index + display flip. No mask, no flicker.
//
// Two rules (design doc §2):
//   1. Never visited → zero resources (no xterm, no PTY subscription).
//   2. Visited → kept alive until ccsm quits or explicit dispose.
//
// Bailout (§5): any anomaly mid-cold-start → dispose this shell and let
// the user click again to retry from scratch. No race-case enumeration,
// no cancellation token machinery.

import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import { useStore } from '../stores/store';
import { SCROLLBACK_LINES_DEFAULT, TERMINAL_FONT_SIZE_DEFAULT } from '../stores/slices/types';
import { warn, log } from '../shared/log';
import { pasteIntoActivePty } from './paste';

export type Shell = {
  sid: string;
  /** DOM wrapper parented under the host. Owns the xterm canvases AND the
   *  per-shell mask div. Never reparented after first attach — visibility
   *  is toggled via `display` + `z-index` only. */
  wrapper: HTMLDivElement;
  /** Mask div sitting inside the wrapper. Shown during cold-start /
   *  reload-of-top, hidden otherwise. */
  mask: HTMLDivElement;
  term: Terminal;
  fit: FitAddon;
  /** `pty.onData` unsubscriber. Lives for the lifetime of the shell. */
  dataUnsubscribe: () => void;
  /** Disposers for textarea-bound listeners (IME, paste, selection-copy). */
  inputDisposers: Array<() => void>;
  /** Composition state — `pty.onData` writes are buffered while true so the
   *  IME preview box doesn't jump. */
  composing: boolean;
  composingBuffer: string[];
  /** Set true after the first cold-start completes; used by the host to
   *  know whether a re-show should trigger any mask UI (it should not). */
  warmed: boolean;
  /** Set true once `term.onData → pty.input` has been wired for this shell.
   *  Used by `usePtyAttachShell` to avoid double-wiring across reload — the
   *  Terminal instance is kept across reloads so the existing disposable
   *  is still live. */
  inputWired: boolean;
  /** Pending font size to apply on next show — set when a Ctrl+wheel zoom
   *  happens while this shell is hidden. */
  pendingFontSize: number | null;
};

const shells: Map<string, Shell> = new Map();
let topSid: string | null = null;

// NOTE: pty.onExit → store._applyPtyExit dispatch lives EXCLUSIVELY on
// the app-level bridge (`src/app-effects/usePtyExitBridge.ts` wired in
// App.tsx). That bridge is mounted unconditionally for every sid, so
// hidden-session crashes still populate `disconnectedSessions[sid]` and
// surface the correct overlay on switch-back.
//
// We deliberately do NOT install a second module-level listener here.
// Doing so caused PR #1396's user-visible reload bug: a single pty:exit
// IPC fanned out to BOTH the bridge and the shell-registry listener,
// dispatching `_applyPtyExit` twice per event. `reloadSession`'s
// expectedExits counter only suppresses one call — the second call then
// re-populated `disconnectedSessions[sid]` with a stale crash entry for
// the pty we ourselves just killed, surfacing the "claude crashed"
// overlay on every healthy reload.

let beforeUnloadHandler: (() => void) | null = null;
function installUnloadCleanupOnce(): void {
  if (beforeUnloadHandler) return;
  if (typeof window === 'undefined') return;
  beforeUnloadHandler = () => disposeAll();
  window.addEventListener('beforeunload', beforeUnloadHandler);
}

export function getShell(sid: string): Shell | undefined {
  return shells.get(sid);
}

export function getTopSid(): string | null {
  return topSid;
}

export function getTopShell(): Shell | undefined {
  return topSid != null ? shells.get(topSid) : undefined;
}

export function shellCount(): number {
  return shells.size;
}

/**
 * Create a fresh shell for `sid`, parent it under `host`, show the mask,
 * and return it. Caller (the attach hook) then drives the cold-start
 * sequence: pty.attach → fetch snapshot → write → subscribe → unmask.
 *
 * The shell becomes the z-stack top synchronously: previously-top shell
 * stays in the layout tree at a lower z-index, but its wrapper's `display`
 * is set to 'none' so it can't paint behind us (saves GPU work).
 */
export function createShell(sid: string, host: HTMLElement): Shell {
  installUnloadCleanupOnce();

  const existing = shells.get(sid);
  if (existing) {
    // Caller asked to create but the shell already exists — promote it
    // and return. Idempotent.
    showShell(sid);
    return existing;
  }

  const scrollback = useStore.getState().scrollbackLines ?? SCROLLBACK_LINES_DEFAULT;
  const fontSize = useStore.getState().terminalFontSizePx ?? TERMINAL_FONT_SIZE_DEFAULT;
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
        if (event.ctrlKey || event.metaKey) window.ccsm?.openExternal?.(uri);
      }),
    );
  } catch (e) {
    warn('shell', 'web-links addon failed', e);
  }
  try {
    term.loadAddon(new ClipboardAddon());
  } catch (e) {
    warn('shell', 'clipboard addon failed', e);
  }
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch (e) {
    warn('shell', 'unicode11 addon failed', e);
  }
  try {
    term.loadAddon(new CanvasAddon());
  } catch (e) {
    warn('shell', 'canvas addon failed', e);
  }

  // Build wrapper + mask. Wrapper covers the host; mask is an absolute-
  // positioned overlay inside the wrapper that the cold-start path hides
  // when content is on screen.
  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-ccsm-shell-sid', sid);
  wrapper.className = 'absolute inset-0';
  wrapper.style.zIndex = '1';

  const mask = document.createElement('div');
  mask.setAttribute('data-ccsm-shell-mask', sid);
  mask.className = 'absolute inset-0';
  mask.style.background = '#000000';
  mask.style.zIndex = '10';
  mask.style.pointerEvents = 'auto';
  wrapper.appendChild(mask);

  // Append to host BEFORE term.open() so xterm initialises against a
  // parented + zero-css-display node. We start hidden so no layout flash
  // before the caller's cold-start path makes it the top.
  host.appendChild(wrapper);

  // Open xterm against the wrapper (mask covers it for now — user sees
  // black while we attach + fetch snapshot).
  try {
    term.open(wrapper);
  } catch (e) {
    warn('shell', 'term.open failed', e);
  }

  // PTY data subscription is NOT installed here — the cold-start sequence
  // is `build xterm → open → fetch snapshot → write → subscribe PTY`
  // (design doc principle, no buffering-listener mode in the renderer).
  // The attach hook calls `subscribeShellData(sid)` AFTER it has written
  // the snapshot into term.
  const shell: Shell = {
    sid,
    wrapper,
    mask,
    term,
    fit,
    dataUnsubscribe: () => {},
    inputDisposers: [],
    composing: false,
    composingBuffer: [],
    warmed: false,
    inputWired: false,
    pendingFontSize: null,
  };
  shells.set(sid, shell);

  installInputListeners(shell);

  // Promote synchronously so the host's react render sees it on top.
  showShell(sid);

  try {
    log.event('shell.created', { sid, count: shells.size });
  } catch {
    /* probe best-effort */
  }
  return shell;
}

/**
 * Promote `sid` to the z-stack top. Idempotent. Hides every other shell
 * via `display:none` (saves paint cost; their xterm WriteBuffer still
 * drains since the per-shell `pty.onData` subscription is independent of
 * visibility). Bumps the new top to `z-index: 2`, demotes the old top to
 * `z-index: 1`.
 *
 * Mask handling is NOT done here — the caller decides whether the new
 * top should show a mask (cold-start: yes; visited switch: no; reload of
 * top: yes; reload of non-top: don't show even after we promote, but
 * we don't promote on non-top reload either).
 */
export function showShell(sid: string): Shell | undefined {
  const shell = shells.get(sid);
  if (!shell) return undefined;

  for (const [otherSid, other] of shells) {
    if (otherSid === sid) continue;
    if (other.wrapper.style.display !== 'none') {
      other.wrapper.style.display = 'none';
      other.wrapper.style.zIndex = '1';
    }
  }
  shell.wrapper.style.display = '';
  shell.wrapper.style.zIndex = '2';
  topSid = sid;

  // Consume any deferred font size that landed while this shell was
  // hidden. Apply in place + refit; the PTY resize falls out of fit.
  if (shell.pendingFontSize != null && shell.warmed) {
    const px = shell.pendingFontSize;
    shell.pendingFontSize = null;
    const cur = (shell.term.options as { fontSize?: number }).fontSize;
    if (cur !== px) {
      try {
        shell.term.options.fontSize = px;
        shell.fit.fit();
        const p = window.ccsmPty?.resize(sid, shell.term.cols, shell.term.rows);
        if (p && typeof (p as Promise<void>).then === 'function') {
          void (p as Promise<void>).catch((e) =>
            warn('shell', 'lazy resize failed', e),
          );
        }
      } catch (e) {
        warn('shell', 'lazy font apply failed', e);
      }
    }
  }

  try {
    window.__ccsmTerm = shell.term;
  } catch {
    /* probe handle is best-effort */
  }

  return shell;
}

export function setMask(sid: string, on: boolean): void {
  const shell = shells.get(sid);
  if (!shell) return;
  shell.mask.style.display = on ? '' : 'none';
}

/**
 * Subscribe the shell to its PTY data stream. Called by the cold-start
 * path AFTER the snapshot has been written, so the listener writes
 * straight to term in arrival order — no seq dedupe, no mode machine.
 *
 * Theoretical loss window: chunks broadcast by main between snapshot
 * capture and this subscribe land in main's headless buffer but never
 * reach the shell's term. Acceptable per design doc §5 — if the user
 * notices missing content, the bailout is `disposeShell(sid)` + click
 * again, which re-snapshots from a now-fresher headless buffer.
 *
 * Idempotent: if the shell already has a non-noop dataUnsubscribe we
 * dispose it first.
 */
export function subscribeShellData(sid: string): void {
  const shell = shells.get(sid);
  if (!shell) return;
  try {
    shell.dataUnsubscribe();
  } catch {
    /* ignore */
  }
  const pty = window.ccsmPty;
  if (!pty?.onData) return;
  shell.dataUnsubscribe = pty.onData(
    (payload: { sid: string; chunk: string; seq: number }) => {
      if (payload.sid !== sid) return;
      const s = shells.get(sid);
      if (!s) return;
      if (s.composing) {
        s.composingBuffer.push(payload.chunk);
        return;
      }
      try {
        s.term.write(payload.chunk);
      } catch {
        /* term may be mid-dispose */
      }
    },
  );
}

/**
 * Tear down `sid`'s shell: unsubscribe PTY, dispose xterm, remove DOM.
 * Falls back to the next-most-recent shell if we just disposed the top.
 * If the registry empties, top becomes null (State 0: blank pane).
 */
export function disposeShell(sid: string): void {
  const shell = shells.get(sid);
  if (!shell) return;
  shells.delete(sid);
  try {
    shell.dataUnsubscribe();
  } catch (e) {
    warn('shell', 'dataUnsubscribe failed', e);
  }
  for (const d of shell.inputDisposers) {
    try {
      d();
    } catch {
      /* ignore */
    }
  }
  shell.inputDisposers.length = 0;
  try {
    shell.term.dispose();
  } catch (e) {
    warn('shell', 'term.dispose failed', e);
  }
  try {
    shell.wrapper.remove();
  } catch {
    /* ignore */
  }
  if (topSid === sid) {
    topSid = null;
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
    // Z-stack collapse: surface the next remaining shell, if any. Per
    // design doc §4: "删的是顶层 → z-stack 自动塌到下一层". We use
    // insertion order — Map preserves it — taking the last (most-recent)
    // remaining shell.
    let next: string | null = null;
    for (const s of shells.keys()) next = s;
    if (next != null) showShell(next);
  }
  try {
    log.event('shell.disposed', { sid, count: shells.size });
  } catch {
    /* probe best-effort */
  }
}

export function disposeAll(): void {
  for (const sid of Array.from(shells.keys())) disposeShell(sid);
}

/**
 * Reload semantics (design doc §4):
 *   term.reset() in place, then the caller re-fetches snapshot + writes.
 *   NOT dispose. The PTY subscription continues to live; main side has
 *   spawned a fresh PTY (callers do `pty.kill` + `pty.spawn` before this).
 *   If this is the top shell, mask while we work; otherwise stay silent.
 */
export function resetShellForReload(sid: string): Shell | undefined {
  const shell = shells.get(sid);
  if (!shell) return undefined;
  try {
    shell.term.reset();
  } catch (e) {
    warn('shell', 'term.reset failed', e);
  }
  if (topSid === sid) setMask(sid, true);
  return shell;
}

/**
 * Apply a new terminal font size:
 *   - top shell: immediate fit + pty.resize (no snapshot replay — xterm
 *     reflows in place; PTY's SIGWINCH causes claude to repaint).
 *   - hidden shells: stash on `pendingFontSize` and apply on next
 *     `showShell` (avoids N concurrent resize IPCs).
 */
export async function applyTerminalFontSize(px: number): Promise<void> {
  for (const [sid, shell] of shells) {
    if (sid === topSid) continue;
    const cur = (shell.term.options as { fontSize?: number }).fontSize;
    shell.pendingFontSize = cur === px ? null : px;
  }
  if (!topSid) return;
  const shell = shells.get(topSid);
  if (!shell) return;
  if (shell.composing) {
    shell.pendingFontSize = px;
    return;
  }
  const cur = (shell.term.options as { fontSize?: number }).fontSize;
  if (cur === px) return;
  try {
    shell.term.options.fontSize = px;
    shell.fit.fit();
    const p = window.ccsmPty?.resize(shell.sid, shell.term.cols, shell.term.rows);
    if (p && typeof (p as Promise<void>).then === 'function') {
      await (p as Promise<void>);
    }
  } catch (e) {
    warn('shell', 'apply fontSize failed', e);
  }
}

export function applyTerminalScrollback(n: number): void {
  for (const shell of shells.values()) {
    try {
      const cur = (shell.term.options as { scrollback?: number }).scrollback;
      if (cur === n) continue;
      shell.term.options.scrollback = n;
    } catch (e) {
      warn('shell', 'apply scrollback failed', e);
    }
  }
}

// Input-side listeners: IME composition guard, capture-phase paste,
// selection-to-clipboard auto-copy, Ctrl/Cmd+C/V/A handler. Same surface
// as the legacy registry (these are UX features, not race handling).
function installInputListeners(shell: Shell): void {
  const { term, sid, wrapper } = shell;
  const ta = term.textarea;
  if (ta) {
    const onStart = () => {
      shell.composing = true;
      shell.composingBuffer.length = 0;
    };
    const onEnd = () => {
      shell.composing = false;
      if (shell.composingBuffer.length > 0) {
        const pending = shell.composingBuffer.join('');
        shell.composingBuffer.length = 0;
        try {
          term.write(pending);
        } catch {
          /* best-effort */
        }
      }
    };
    ta.addEventListener('compositionstart', onStart);
    ta.addEventListener('compositionend', onEnd);
    shell.inputDisposers.push(() => {
      try {
        ta.removeEventListener('compositionstart', onStart);
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

  let keyboardPasteHandled = false;
  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (keyboardPasteHandled) {
      keyboardPasteHandled = false;
      return;
    }
    const text = e.clipboardData?.getData('text/plain') ?? '';
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
    warn('shell', 'onSelectionChange attach failed', e);
  }

  const pasteFromClipboard = (): void => {
    keyboardPasteHandled = true;
    setTimeout(() => {
      keyboardPasteHandled = false;
    }, 0);
    let text: string | undefined;
    try {
      text = window.ccsmPty?.clipboard?.readText() || undefined;
    } catch {
      /* best-effort */
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
        return true;
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
    warn('shell', 'attachCustomKeyEventHandler failed', e);
  }
}

/** Test-only: drop all shells silently, reset module state. */
export function __resetShellRegistryForTests(): void {
  for (const shell of shells.values()) {
    try {
      shell.dataUnsubscribe();
    } catch {
      /* ignore */
    }
    for (const d of shell.inputDisposers) {
      try {
        d();
      } catch {
        /* ignore */
      }
    }
    shell.inputDisposers.length = 0;
    try {
      shell.term.dispose();
    } catch {
      /* ignore */
    }
    try {
      shell.wrapper.remove();
    } catch {
      /* ignore */
    }
  }
  shells.clear();
  topSid = null;
  if (beforeUnloadHandler && typeof window !== 'undefined') {
    try {
      window.removeEventListener('beforeunload', beforeUnloadHandler);
    } catch {
      /* ignore */
    }
  }
  beforeUnloadHandler = null;
  if (typeof window !== 'undefined') {
    try {
      delete window.__ccsmTerm;
    } catch {
      /* ignore */
    }
  }
}
