import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';

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

  term = new Terminal({
    fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
    fontSize: 13,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 5000,
    theme: { background: '#000000' },
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

  // v0.2.2 paste fix: host-level capture-phase paste listener.
  //
  // Background: PR #1243 removed a custom Ctrl+V handler that was sending
  // pastes twice (once via direct pty.write, once via xterm's built-in
  // textarea paste → onData pipeline). The fix correctly delegates to
  // xterm's built-in pipeline — BUT that pipeline only fires when the
  // browser dispatches the native `paste` event to xterm's hidden helper
  // textarea, which requires that textarea to have focus. In practice
  // users frequently click on the surrounding host wrapper / sidebar /
  // anywhere that drains focus from the helper textarea, so the native
  // paste event lands on `host` (or an ancestor) and xterm never sees
  // it → 0 pastes (v0.2.1 user report).
  //
  // Fix: install a capture-phase paste listener on the host element
  // itself and route the clipboard text through `term.paste(text)`. This
  //   - preserves the single canonical data path (term.paste →
  //     prepareTextForTerminal → onData → usePtyAttach → pty.write), so
  //     bracketed-paste wrapping and CR/LF normalization stay intact;
  //   - does NOT depend on which descendant of host owns focus;
  //   - uses capture phase + stopPropagation so xterm's own textarea /
  //     element paste listeners cannot also fire on the same event
  //     (prevents regression to the v0.2.0 double-paste bug);
  //   - preventDefault keeps the browser from inserting the pasted text
  //     into any contenteditable / input that might be focused inside
  //     the host subtree.
  host.addEventListener(
    'paste',
    (ev) => {
      const text = ev.clipboardData?.getData('text/plain');
      if (!text) return;
      ev.preventDefault();
      ev.stopPropagation();
      term?.paste(text);
    },
    true,
  );

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

  // Copy keyboard shortcuts (Windows Terminal style):
  //   Ctrl+C        → if selection, copy; else fall through to SIGINT
  //   Ctrl+Shift+C  → explicit always-copy
  //
  // Paste is intentionally NOT handled here. xterm.js has a built-in paste
  // pipeline (textarea `paste` event → `term.paste()` → `onData` → main
  // process `pty.write`) which is already wired by `usePtyAttach`. A
  // previous custom Ctrl+V / Ctrl+Shift+V handler here ran in addition to
  // the built-in pipeline — returning `false` only suppresses xterm's
  // keydown→data dispatch, not the browser's native `paste` clipboard
  // event — so every paste was sent twice. Delegating to xterm's built-in
  // pipeline gives us a single, canonical paste path.
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const isC = ev.key === 'C' || ev.key === 'c';

    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && isC) {
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
    if (ev.ctrlKey && ev.shiftKey && isC) {
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
  if (typeof window !== 'undefined') {
    delete window.__ccsmTerm;
  }
}
