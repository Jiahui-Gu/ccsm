import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import { useStore } from '../stores/store';
import { SCROLLBACK_LINES_DEFAULT } from '../stores/slices/types';

// Module-scope singleton state for the renderer's xterm view.
//
// Why a module-scope singleton (NOT per-React-mount):
//   - Recreating the Terminal on every session switch is expensive: the
//     canvas renderer rebuilds its glyph atlas, addons re-allocate, and
//     in dev React StrictMode would double-invoke the constructor.
//   - ccsm's session-keepalive guarantee: the user can flip between
//     sessions without the underlying terminal/PTY pairing being torn
//     down. The PTY lives in the main process; the rendered view is a
//     single xterm bound to whichever sid is active. Switching sessions
//     = `term.reset()` + IPC re-attach with the new sid's snapshot, no
//     DOM reconstruction.
//
// All three terminal hooks (useXtermSingleton, usePtyAttach,
// useTerminalResize) share this state via the accessors below.
//
// `window.ccsmPty` and `window.__ccsmTerm` are typed via `src/pty.d.ts`,
// which is the canonical renderer-side view of the preload bridge surface.

let term: Terminal | null = null;
let fit: FitAddon | null = null;
let activeSid: string | null = null;
let unsubscribeData: (() => void) | null = null;
let inputDisposable: { dispose: () => void } | null = null;
// Handoff flag between the Ctrl/Cmd+V keydown hook and the capture-phase
// `paste` listener. Module-level (not closed over `ensureTerminal`) so a
// keydown that was attached against an earlier Terminal instance still
// suppresses the native paste event reaching the current host element.
// See the paste-path block inside `ensureTerminal` for details.
let keyboardPasteHandled = false;
// L4 PR-D (#866): callback installed by `usePtyAttach` once it has wired the
// snapshot/dedupe-by-seq flow. Invoked by `useTerminalResize` AFTER pushing
// a new size to the headless mirror so the visible xterm can re-render
// from the reflowed buffer's cell content rather than waiting on claude
// to repaint (claude's TUI is alt-screen and does not repaint on
// SIGWINCH unless input arrives — same root cause as #852). The handler
// is responsible for: (1) requesting a fresh `getBufferSnapshot`,
// (2) re-installing the buffering listener so live chunks during the
// replay window aren't lost, (3) writing the snapshot, (4) bumping
// the per-attach `snapSeq` to the snapshot's seq so subsequent live
// chunks dedupe correctly.
let snapshotReplay: (() => Promise<void>) | null = null;

export function getTerm(): Terminal | null {
  return term;
}

export function getFit(): FitAddon | null {
  return fit;
}

export function getActiveSid(): string | null {
  return activeSid;
}

export function setActiveSid(sid: string | null): void {
  activeSid = sid;
}

export function getUnsubscribeData(): (() => void) | null {
  return unsubscribeData;
}

export function setUnsubscribeData(fn: (() => void) | null): void {
  unsubscribeData = fn;
}

export function getInputDisposable(): { dispose: () => void } | null {
  return inputDisposable;
}

export function setInputDisposable(d: { dispose: () => void } | null): void {
  inputDisposable = d;
}

/**
 * L4 PR-D (#866): get the snapshot-replay handler installed by `usePtyAttach`.
 * Returns null when no session is attached. Callers (currently only
 * `useTerminalResize`) await the returned promise so they can sequence
 * subsequent work after the replay completes.
 */
export function getSnapshotReplay(): (() => Promise<void>) | null {
  return snapshotReplay;
}

export function setSnapshotReplay(fn: (() => Promise<void>) | null): void {
  snapshotReplay = fn;
}

/**
 * Create (or re-attach) the singleton Terminal against `host`. Idempotent:
 * subsequent calls reuse the cached instance and only re-`open` if React
 * remounted into a different DOM node.
 */
export function ensureTerminal(host: HTMLDivElement): Terminal {
  if (term) {
    if ((term as any)._core?._parent !== host) {
      try {
        term.open(host);
      } catch {
        // open() throws if already attached to this exact host; ignore.
      }
    }
    return term;
  }

  // The scrollback cap is read ONCE at construction. Changing the user
  // setting after the singleton exists does not retroactively resize the
  // visible buffer (xterm.js doesn't expose a mutable scrollback setter),
  // so the SettingsDialog helper text says "applies on next launch". Read
  // synchronously from the zustand store, which `hydrateStore()` populates
  // from db:load before TerminalPane mounts (App.tsx gates on `hydrated`).
  // Falls back to the default constant if the store somehow isn't ready
  // yet (e.g. test mounts that bypass hydrate).
  const scrollback =
    useStore.getState().scrollbackLines ?? SCROLLBACK_LINES_DEFAULT;
  term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback,
    theme: { background: '#000000' },
    // Wheel-scroll tuning. xterm's `Viewport.getLinesScrolled` multiplies
    // `event.deltaY` by `scrollSensitivity` BEFORE dividing by row height
    // (~17px at our 13px font), so a Windows precision-mouse / touchpad
    // notch reporting `deltaY` in the 100–400px range with the default
    // sensitivity of 1 lands the user 6–25 lines down per notch — "a
    // light flick scrolls to the middle of the page" (see #user-report
    // 2026-05-21). 0.5 brings a ~120px notch back to ~3 lines, matching
    // a native CLI terminal's feel without making intentional fast scrolls
    // sluggish (the Alt modifier still gives 5x for long jumps).
    //
    // `fastScrollSensitivity` and `fastScrollModifier` are pinned to their
    // current xterm defaults explicitly so an upstream default change can't
    // resurface this bug; if a future xterm starts treating
    // `fastScrollModifier: 'alt'` as default-fast, the runaway scroll
    // returns silently.
    scrollSensitivity: 0.5,
    fastScrollSensitivity: 5,
    fastScrollModifier: 'alt',
  });
  fit = new FitAddon();
  term.loadAddon(fit);
  try {
    // Ctrl-click (Win/Linux) / Cmd-click (macOS) opens the link in the
    // user's default browser; plain clicks are deliberately a no-op.
    //
    // Why the modifier gate: matches the Windows Terminal / VS Code
    // convention so muscle memory carries over, and avoids hijacking
    // accidental clicks on URL-shaped output (paths, ANSI escapes that
    // look like links, etc.) from claude's TUI.
    //
    // Why route through preload (not WebLinksAddon's default `window.open`):
    // the BrowserWindow installs a `setWindowOpenHandler` returning
    // `{action:'deny'}` to block popups, which silently swallows the
    // default behaviour. `window.ccsm.openExternal` hands the URI to the
    // main process, which applies a strict http(s) scheme whitelist
    // before calling `shell.openExternal` (see utilityIpc.ts).
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        if (event.ctrlKey || event.metaKey) {
          window.ccsm?.openExternal?.(uri);
        }
      }),
    );
  } catch (e) {
    console.warn('[TerminalPane] web-links addon failed', e);
  }
  try {
    term.loadAddon(new ClipboardAddon());
  } catch (e) {
    console.warn('[TerminalPane] clipboard addon failed', e);
  }
  try {
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
  } catch (e) {
    console.warn('[TerminalPane] unicode11 addon failed', e);
  }
  // Canvas renderer is the safe middle ground (DOM is slow on dense
  // output, WebGL flakes under RDP). Fall back silently to default DOM
  // renderer if the GPU path can't initialise.
  try {
    term.loadAddon(new CanvasAddon());
  } catch (e) {
    console.warn('[TerminalPane] canvas addon failed, falling back to DOM', e);
  }

  term.open(host);

  // Single canonical paste path.
  //
  // xterm.js exposes two competing entry points for paste:
  //   (1) an `attachCustomKeyEventHandler` keydown hook
  //   (2) a built-in `paste` DOM-event pipeline (`handlePasteEvent` →
  //       `coreService.triggerDataEvent` → `onData`), wired to BOTH
  //       `this.textarea` and `this.element`.
  //
  // Electron adds a third: `role: 'paste'` in any application menu
  // resolves Ctrl/Cmd+V via `webContents.paste()` (OS-level), which
  // bypasses the DOM entirely. (We've removed that role from the
  // hidden accelerator menu in `electron/lifecycle/appLifecycle.ts`,
  // but it can still arrive from the right-click context menu.)
  //
  // Letting two of these fire concurrently is what caused v0.2.0's
  // double-paste; disabling the keydown hook (v0.2.1) instead left
  // paste depending on which descendant of host happened to be
  // focused, manifesting as zero pastes when focus was on the screen
  // canvas. Both failure modes have the same root cause: we were
  // riding xterm's internals instead of owning the user intent.
  //
  // Fix: own the user intent. Treat the terminal pane as a single
  // atomic unit, like a native CLI terminal. Every "user wants to
  // paste" signal — Ctrl/Cmd+V keydown, Ctrl/Cmd+Shift+V keydown,
  // bracketed `paste` DOM events — converges on one call:
  //
  //   ccsmPty.input(activeSid, clipboard.readText())
  //
  // Implementation: install a capture-phase `paste` listener on the
  // host wrapper that swallows xterm's built-in pipeline before it
  // can call `triggerDataEvent`, and route Ctrl/Cmd+V via the
  // keydown hook below (returning `false` to also stop xterm from
  // translating the keystroke into a 0x16 SYN byte).
  //
  // The capture listener also routes `paste` events that did NOT
  // originate from our keydown hook (right-click → Paste, Shift+Insert,
  // OS-level `webContents.paste()` via context menu) into the same
  // canonical sink, so every paste source converges.
  //
  // Subtlety: when the user types Ctrl+V, the keydown hook reads the
  // clipboard and injects synchronously. Some browsers / Electron
  // versions then dispatch a native `paste` event a moment later;
  // the keydown handler sets `keyboardPasteHandled` so this listener
  // discards that follow-up event and we paste exactly once.
  const onPasteCapture = (e: ClipboardEvent): void => {
    e.stopImmediatePropagation();
    e.preventDefault();
    if (keyboardPasteHandled) {
      keyboardPasteHandled = false;
      return;
    }
    const text = e.clipboardData?.getData('text/plain');
    if (text && activeSid) {
      try {
        window.ccsmPty.input(activeSid, text);
      } catch {
        // best-effort — write can fail if PTY isn't attached.
      }
    }
  };
  host.addEventListener('paste', onPasteCapture, { capture: true });

  // ttyd-style: auto-copy on selection change. Works in alt-screen apps
  // (claude/Ink) when user holds Shift to bypass mouse tracking and
  // drags. Use Electron's clipboard via preload because navigator.clipboard
  // requires user-activation that xterm's keydown swallow doesn't reliably
  // propagate, and silently fails under default contextIsolation.
  term.onSelectionChange(() => {
    if (!term) return;
    const sel = term.getSelection();
    if (sel) {
      try {
        window.ccsmPty?.clipboard?.writeText(sel);
      } catch {
        // ignore clipboard failures — selection still highlights.
      }
    }
  });

  const pasteFromClipboard = (): void => {
    keyboardPasteHandled = true;
    // Reset the flag on a macrotask (NOT a microtask). The browser dispatches
    // the follow-up native `paste` event after our keydown handler returns
    // but before the next task tick — microtasks fire BEFORE the native
    // paste, leaving the flag false when the capture listener runs and
    // causing a second inject (the v0.2.0 double-paste comes back). A
    // setTimeout 0 task lands AFTER the native paste dispatch, so the
    // capture listener sees the flag and suppresses.
    setTimeout(() => { keyboardPasteHandled = false; }, 0);
    try {
      const text = window.ccsmPty?.clipboard?.readText();
      if (text && activeSid) window.ccsmPty.input(activeSid, text);
    } catch {
      // best-effort — clipboard read can fail under permission edge cases.
    }
  };

  // Copy/paste keyboard shortcuts (Windows Terminal style):
  //   Ctrl+C  → if selection, copy; else fall through to SIGINT
  //   Ctrl+V  → paste (single canonical path, see above)
  //   Ctrl+Shift+C / Ctrl+Shift+V → explicit always-clipboard
  // On macOS the same handler matches Cmd via `metaKey`.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const mod = ev.ctrlKey || ev.metaKey;
    if (!mod || ev.altKey) return true;
    const isC = ev.key === 'C' || ev.key === 'c';
    const isV = ev.key === 'V' || ev.key === 'v';

    if (!ev.shiftKey && isC) {
      const sel = term?.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          // ignore clipboard failures — selection still highlights.
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
      const sel = term?.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {
          // ignore clipboard failures — selection still highlights.
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

  // Probe hook for e2e harness — exposed unconditionally because the
  // direct-xterm probes (harness-real-cli pty-pid-stable-across-switch /
  // switch-session-keeps-chat) drive the production webpack bundle and
  // would otherwise have no way to reach the live Terminal handle. This
  // mirrors the unconditional `window.__ccsmStore` exposure in App.tsx —
  // a debug affordance, not a security boundary, since the renderer is
  // already a single-origin Electron context with no remote content.
  window.__ccsmTerm = term;

  return term;
}

/**
 * Test-only: clear singleton state so each test starts from a clean slate.
 * Intentionally NOT exported via barrel — only direct importers (tests)
 * should reach for it.
 */
export function __resetSingletonForTests(): void {
  term = null;
  fit = null;
  activeSid = null;
  unsubscribeData = null;
  inputDisposable = null;
  snapshotReplay = null;
  keyboardPasteHandled = false;
  if (typeof window !== 'undefined') {
    delete window.__ccsmTerm;
  }
}
