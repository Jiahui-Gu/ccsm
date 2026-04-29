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
    term.loadAddon(new WebLinksAddon());
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

  // Copy/paste keyboard shortcuts (Windows Terminal style):
  //   Ctrl+C  → if selection, copy; else fall through to SIGINT
  //   Ctrl+V  → paste
  //   Ctrl+Shift+C / Ctrl+Shift+V → explicit always-clipboard
  term.attachCustomKeyEventHandler((ev) => {
    if (ev.type !== 'keydown') return true;
    const isC = ev.key === 'C' || ev.key === 'c';
    const isV = ev.key === 'V' || ev.key === 'v';

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
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && isV) {
      try {
        const text = window.ccsmPty?.clipboard?.readText();
        if (text && activeSid) window.ccsmPty.input(activeSid, text);
      } catch {
        // ignore clipboard failures — paste is best-effort.
      }
      return false;
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
    if (ev.ctrlKey && ev.shiftKey && isV) {
      try {
        const text = window.ccsmPty?.clipboard?.readText();
        if (text && activeSid) window.ccsmPty.input(activeSid, text);
      } catch {
        // ignore clipboard failures — paste is best-effort.
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
  if (typeof window !== 'undefined') {
    delete window.__ccsmTerm;
  }
}
