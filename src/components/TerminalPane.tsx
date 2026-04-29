import { useCallback, useEffect, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { CanvasAddon } from '@xterm/addon-canvas';
import '@xterm/xterm/css/xterm.css';
import { useTranslation } from '../i18n/useTranslation';
import { useStore } from '../stores/store';

// TerminalPane mounts a singleton xterm.js Terminal that we attach/detach
// against per-session PTYs over IPC (window.ccsmPty). This is the React
// port of the validated spike at spike/xterm-attach/src/renderer/renderer.mjs.
//
// Why a module-scope singleton (NOT per-React-mount):
//   - Recreating the Terminal on every session switch is expensive: the
//     canvas renderer rebuilds its glyph atlas, addons re-allocate, and
//     in dev React StrictMode would double-invoke the constructor.
//   - More importantly, ccsm's session-keepalive guarantee says the user
//     can flip between sessions without the underlying terminal/PTY pairing
//     being torn down. The PTY lives in the main process; the rendered
//     view is a single xterm bound to whichever sid is active. Switching
//     sessions = `term.reset()` + IPC re-attach with the new sid's
//     snapshot, no DOM reconstruction.
//
// Lifecycle:
//   1. First mount creates the singleton: addons (fit/weblinks/clipboard/
//      unicode11/canvas), key handler, selection→clipboard, title→document.
//   2. sessionId effect: detach prev (dispose subs, await pty.detach),
//      term.reset(), pty.attach(new sid) → write snapshot, subscribe to
//      pty.onData filtered by activeSid, wire term.onData → pty.input,
//      then fit().
//   3. ResizeObserver (80ms debounce) → fit + pty.resize.
//   4. pty.onExit for active sid → flip to error state with Retry.
//
// The host div carries [data-terminal-host] and [data-active-sid={sessionId}]
// so the e2e probes (PR-7) can locate the active terminal deterministically.

declare global {
  interface Window {
    // Local stub until PR-3 lands the proper src/pty.d.ts. PR-8 收口 may
    // remove this if the global declaration is in place by then.
    ccsmPty: any;
    __ccsmTerm?: Terminal;
  }
}

type Props = {
  sessionId: string;
  cwd: string;
};

type State =
  | { kind: 'attaching' }
  | { kind: 'ready' }
  // `exit` is the new shape — distinguishes user-intentional clean exit
  // (no signal, code 0) from a crash. The former renders a neutral
  // overlay + "claude exited" copy; the latter renders the red overlay
  // + "claude crashed... not a ccsm bug" copy. Both show Retry. The
  // legacy `error` shape stays for spawn/attach failures (spawn IPC
  // returned !ok, ccsmPty unavailable, etc.) which are NOT pty exits.
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

// Module-scope singleton state. Initialised lazily on first mount so we
// don't run xterm constructors at import time (would explode in non-DOM
// test environments).
let term: Terminal | null = null;
let fit: FitAddon | null = null;
let activeSid: string | null = null;
let unsubscribeData: (() => void) | null = null;
let inputDisposable: { dispose: () => void } | null = null;

function ensureTerminal(host: HTMLDivElement): Terminal {
  if (term) {
    // Re-open against the new host element if React remounted us into a
    // different node (rare — App keeps the pane mounted — but harmless).
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

  // OSC 0 title-stream → notify bridge. The Claude CLI emits
  // `\x1b]0;<glyph> Claude Code\x07` per state transition, encoding state
  // in the leading glyph (Sparkle ✳ = idle/waiting for user, Braille
  // ⠂⠐⠁... = running). Forward each title to main so the title-state
  // bridge can drive desktop notifications off the same signal Windows
  // Terminal already trusts (see microsoft/terminal Tab.cpp's
  // `_GetActiveTitle`). We pull `activeSid` at fire time — one xterm
  // singleton serves all sessions, so the title we just received belongs
  // to whichever sid is currently attached.
  term.onTitleChange((title) => {
    if (!activeSid) return;
    try {
      (window as unknown as {
        ccsmSession?: { reportTitleState?: (sid: string, title: string) => void };
      }).ccsmSession?.reportTitleState?.(activeSid, title);
    } catch {
      // Defensive: never let a notify-pipe error break the terminal.
    }
  });

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
        } catch {}
        return false;
      }
      return true;
    }
    if (ev.ctrlKey && !ev.shiftKey && !ev.altKey && isV) {
      try {
        const text = window.ccsmPty?.clipboard?.readText();
        if (text && activeSid) window.ccsmPty.input(activeSid, text);
      } catch {}
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && isC) {
      const sel = term?.getSelection();
      if (sel) {
        try {
          window.ccsmPty?.clipboard?.writeText(sel);
        } catch {}
      }
      return false;
    }
    if (ev.ctrlKey && ev.shiftKey && isV) {
      try {
        const text = window.ccsmPty?.clipboard?.readText();
        if (text && activeSid) window.ccsmPty.input(activeSid, text);
      } catch {}
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

export function TerminalPane({ sessionId, cwd: _cwd }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [state, setState] = useState<State>({ kind: 'attaching' });
  const { t } = useTranslation();
  // Store action — clear the disconnect entry on respawn success so the
  // sidebar red dot disappears the moment the pty is back. Pulled via
  // selector so this component re-renders only when the function ref
  // changes (it doesn't, in practice — zustand actions are stable). We
  // route through a ref so the attach effect doesn't need to depend on
  // it (and re-run unnecessarily).
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  // Tracks the sessionId we're currently attaching for so a stale resolve
  // from a previous session can't clobber the current one when the user
  // switches quickly.
  const requestedSidRef = useRef<string>(sessionId);
  // Bumped by Retry to force the attach effect to re-run for the same sid.
  const [attachNonce, setAttachNonce] = useState(0);

  // Mount-once: instantiate the singleton against our host div.
  useEffect(() => {
    if (!hostRef.current) return;
    ensureTerminal(hostRef.current);
  }, []);

  // ResizeObserver with 80ms debounce → fit + pty.resize.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    const ro = new ResizeObserver(() => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        if (!term || !fit || !activeSid) return;
        try {
          fit.fit();
          const { cols, rows } = term;
          window.ccsmPty?.resize(activeSid, cols, rows);
        } catch (e) {
          console.warn('[TerminalPane] fit failed', e);
        }
      }, 80);
    });
    ro.observe(host);
    return () => {
      if (debounce) clearTimeout(debounce);
      ro.disconnect();
    };
  }, []);

  // Attach effect: on sessionId change (or Retry), detach the previous
  // session, reset the terminal, attach the new one, and wire data flow.
  useEffect(() => {
    requestedSidRef.current = sessionId;
    let cancelled = false;
    setState({ kind: 'attaching' });

    (async () => {
      const pty = window.ccsmPty;
      if (!pty) {
        if (!cancelled) setState({ kind: 'error', message: 'ccsmPty unavailable' });
        return;
      }

      const prevSid = activeSid;
      if (prevSid && prevSid !== sessionId) {
        if (unsubscribeData) {
          try {
            unsubscribeData();
          } catch {}
          unsubscribeData = null;
        }
        if (inputDisposable) {
          try {
            inputDisposable.dispose();
          } catch {}
          inputDisposable = null;
        }
        try {
          await pty.detach(prevSid);
        } catch {
          // detach failure is non-fatal — main may already have torn it down.
        }
      } else if (prevSid === sessionId) {
        // Same sid (Retry path): tear down stale subscriptions before re-attaching
        // so we don't double-write incoming chunks.
        if (unsubscribeData) {
          try {
            unsubscribeData();
          } catch {}
          unsubscribeData = null;
        }
        if (inputDisposable) {
          try {
            inputDisposable.dispose();
          } catch {}
          inputDisposable = null;
        }
      }

      if (cancelled || requestedSidRef.current !== sessionId) return;

      if (term) term.reset();

      try {
        // Spawn-on-attach-null fallback. The renderer drives session
        // lifecycle, so an attach against a sid main has not seen yet
        // returns null — we then ask main to spawn the pty (using the
        // session's cwd) and re-attach. Subsequent attaches reuse the
        // existing pty (spawnPtySession is idempotent on sid).
        let res = (await pty.attach(sessionId)) as
          | { snapshot: string; cols: number; rows: number; pid: number }
          | null;
        if (!res) {
          const spawnResult = (await pty.spawn(sessionId, _cwd ?? '')) as
            | { ok: true; sid: string; pid: number; cols: number; rows: number }
            | { ok: false; error: string };
          if (!spawnResult || spawnResult.ok === false) {
            const reason =
              spawnResult && spawnResult.ok === false ? spawnResult.error : 'spawn_failed';
            throw new Error(reason);
          }
          res = (await pty.attach(sessionId)) as
            | { snapshot: string; cols: number; rows: number; pid: number }
            | null;
          if (!res) throw new Error('attach_failed_after_spawn');
        }
        const { snapshot, cols, rows } = res;
        if (cancelled || requestedSidRef.current !== sessionId) return;

        activeSid = sessionId;
        if (term) {
          try {
            term.resize(cols, rows);
          } catch {}
          if (snapshot) term.write(snapshot);
        }

        unsubscribeData = pty.onData((payload: { sid: string; chunk: string }) => {
          if (payload.sid !== activeSid) return;
          term?.write(payload.chunk);
        });

        if (term) {
          inputDisposable = term.onData((data: string) => {
            if (activeSid) window.ccsmPty.input(activeSid, data);
          });
        }

        // Push the current container size to the backend so claude
        // re-wraps to the visible viewport rather than the spawn-time cols/rows.
        if (fit && term && activeSid) {
          try {
            fit.fit();
            window.ccsmPty.resize(activeSid, term.cols, term.rows);
          } catch (e) {
            console.warn('[TerminalPane] post-attach fit failed', e);
          }
        }

        // Task #548 — transfer keyboard focus to the embedded xterm so the
        // user's first keystroke after spawning / importing / resuming a
        // session reaches claude's TUI rather than whichever sidebar
        // button or shortcut element triggered the create. App.tsx blurs
        // the trigger synchronously, but with no explicit handoff the
        // body becomes the activeElement and Enter ends up as a no-op.
        // Calling term.focus() here covers all entry paths (sidebar
        // click, keyboard shortcut, import, reopen-resume) because they
        // all funnel through this attach effect.
        if (term) {
          try {
            term.focus();
          } catch (e) {
            console.warn('[TerminalPane] term.focus failed', e);
          }
        }

        if (!cancelled) setState({ kind: 'ready' });
        // Successful (re-)attach means whatever pty is running for this
        // sid is healthy — drop any stale disconnect entry so the
        // sidebar red dot clears and a future crash starts from a clean
        // slate. Idempotent if no entry exists.
        clearPtyExitRef.current(sessionId);
      } catch (err) {
        if (cancelled || requestedSidRef.current !== sessionId) return;
        const message = err instanceof Error ? err.message : String(err);
        setState({ kind: 'error', message });
      }
    })();

    return () => {
      cancelled = true;
    };
    // attachNonce is intentional: bumping it re-runs the attach for Retry.
  }, [sessionId, attachNonce]);

  // pty:exit subscription for the active session → flip to exit state
  // with a classification (clean vs crashed). The classification rule
  // mirrors the store's `_applyPtyExit` logic — kept in lockstep
  // intentionally so the active-pane overlay and the sidebar red-dot
  // signal are always consistent. `t` is intentionally excluded from
  // deps: changing language while a session is alive should not re-
  // subscribe; localized strings are resolved at render time.
  useEffect(() => {
    const pty = window.ccsmPty;
    if (!pty?.onExit) return;
    const unsubscribe = pty.onExit(
      (evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => {
        if (evt.sessionId !== activeSid) return;
        const signal = evt.signal ?? null;
        const code = evt.code ?? null;
        const exitKind: 'clean' | 'crashed' =
          signal == null && code === 0 ? 'clean' : 'crashed';
        const detail =
          signal != null
            ? `signal ${signal}`
            : code != null
              ? `exit code ${code}`
              : 'unknown';
        setState({ kind: 'exit', exitKind, detail });
      },
    );
    return () => {
      try {
        unsubscribe?.();
      } catch {}
    };
  }, []);

  const onRetry = useCallback(() => {
    setAttachNonce((n) => n + 1);
  }, []);

  return (
    <div
      className="relative flex-1 w-full h-full bg-black ring-1 ring-inset ring-white/5"
      data-terminal-host
      data-active-sid={sessionId}
    >
      <div ref={hostRef} className="absolute inset-0" />
      {state.kind === 'attaching' && (
        <div className="absolute inset-0 z-10 flex items-center justify-center text-neutral-400 text-sm pointer-events-none">
          Attaching...
        </div>
      )}
      {state.kind === 'error' && (
        // z-10 so the overlay sits above xterm's canvas layers (the canvas
        // renderer stacks its own absolutely-positioned canvases inside the
        // host div with non-zero z-index — without an explicit z here the
        // Retry button is rendered but unclickable). select-text on the
        // message so the user can highlight + Ctrl+C the error to share
        // (e.g. "spawn_failed: ... error code:267") with support.
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80">
          <div className="text-red-400 max-w-md text-center break-words px-4 select-text">
            {state.message}
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
          >
            Retry
          </button>
        </div>
      )}
      {state.kind === 'exit' && (
        // Two-tone overlay: clean exits get a neutral/dim background
        // (user typed /exit on purpose, no alarm); crashed exits keep
        // the red treatment so the user notices. Copy is locked in
        // i18n — `terminal.exitedClean` reassures, `terminal.exitedCrash`
        // explicitly disclaims ccsm involvement and points at the
        // on-disk transcript so the user knows their work is safe.
        // z-10 + select-text rationale matches the `error` overlay above.
        <div
          data-pty-exit-kind={state.exitKind}
          className={
            state.exitKind === 'crashed'
              ? 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-black/80'
              : 'absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 text-sm bg-neutral-900/85'
          }
        >
          <div
            className={
              state.exitKind === 'crashed'
                ? 'text-state-error-text max-w-md text-center break-words px-4 select-text'
                : 'text-neutral-300 max-w-md text-center break-words px-4 select-text'
            }
          >
            {state.exitKind === 'crashed'
              ? t('terminal.exitedCrash', { detail: state.detail })
              : t('terminal.exitedClean')}
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
          >
            {t('terminal.exitedRetry')}
          </button>
        </div>
      )}
    </div>
  );
}

export default TerminalPane;
