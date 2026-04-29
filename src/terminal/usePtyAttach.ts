import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { classifyPtyExit } from '../lib/ptyExitClassifier';
import {
  getTerm,
  getFit,
  getActiveSid,
  setActiveSid,
  getUnsubscribeData,
  setUnsubscribeData,
  getInputDisposable,
  setInputDisposable,
} from './xtermSingleton';

export type PtyAttachState =
  | { kind: 'attaching' }
  | { kind: 'ready' }
  // `exit` distinguishes user-intentional clean exit (no signal, code 0)
  // from a crash. The former renders a neutral overlay + "claude exited"
  // copy; the latter renders the red overlay + "claude crashed... not a
  // ccsm bug" copy. Both show Retry. The legacy `error` shape stays for
  // spawn/attach failures (spawn IPC returned !ok, ccsmPty unavailable,
  // etc.) which are NOT pty exits.
  | { kind: 'exit'; exitKind: 'clean' | 'crashed'; detail: string }
  | { kind: 'error'; message: string };

export type UsePtyAttachResult = {
  state: PtyAttachState;
  onRetry: () => void;
};

/**
 * Owns the PTY lifecycle for a given sessionId:
 *   1. On sessionId (or Retry) change: detach previous, reset terminal,
 *      attach new (with spawn-on-null fallback), write snapshot, wire
 *      onData both directions, fit, focus.
 *   2. Subscribes to `pty.onExit` for the active sid → flips state to
 *      `exit` with classification (clean vs crashed) consistent with
 *      `classifyPtyExit` so the overlay and the sidebar red-dot signal
 *      stay aligned.
 *   3. On successful (re-)attach, clears any stale disconnect entry from
 *      the store so the sidebar red dot disappears.
 *
 * Returns `{ state, onRetry }` for the host component to render the
 * appropriate overlay (attaching / error / exit) and Retry button.
 */
export function usePtyAttach(sessionId: string, cwd: string): UsePtyAttachResult {
  const [state, setState] = useState<PtyAttachState>({ kind: 'attaching' });
  // Store action — clear the disconnect entry on respawn success so the
  // sidebar red dot disappears the moment the pty is back. Routed through
  // a ref so the attach effect doesn't depend on it (and re-run unnecessarily).
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  // Tracks the sessionId we're currently attaching for so a stale resolve
  // from a previous session can't clobber the current one when the user
  // switches quickly.
  const requestedSidRef = useRef<string>(sessionId);
  // Bumped by Retry to force the attach effect to re-run for the same sid.
  const [attachNonce, setAttachNonce] = useState(0);

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

      const prevSid = getActiveSid();
      if (prevSid && prevSid !== sessionId) {
        const unsub = getUnsubscribeData();
        if (unsub) {
          try {
            unsub();
          } catch {
            // already torn down — safe to ignore.
          }
          setUnsubscribeData(null);
        }
        const inDisp = getInputDisposable();
        if (inDisp) {
          try {
            inDisp.dispose();
          } catch {
            // already disposed — safe to ignore.
          }
          setInputDisposable(null);
        }
        try {
          await pty.detach(prevSid);
        } catch {
          // detach failure is non-fatal — main may already have torn it down.
        }
      } else if (prevSid === sessionId) {
        // Same sid (Retry path): tear down stale subscriptions before re-attaching
        // so we don't double-write incoming chunks.
        const unsub = getUnsubscribeData();
        if (unsub) {
          try {
            unsub();
          } catch {
            // already torn down — safe to ignore.
          }
          setUnsubscribeData(null);
        }
        const inDisp = getInputDisposable();
        if (inDisp) {
          try {
            inDisp.dispose();
          } catch {
            // already disposed — safe to ignore.
          }
          setInputDisposable(null);
        }
      }

      if (cancelled || requestedSidRef.current !== sessionId) return;

      const term = getTerm();
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
          const spawnResult = (await pty.spawn(sessionId, cwd ?? '')) as
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

        setActiveSid(sessionId);
        const t2 = getTerm();
        if (t2) {
          try {
            t2.resize(cols, rows);
          } catch {
            // resize is best-effort — proceed with snapshot write.
          }
          if (snapshot) t2.write(snapshot);
        }

        setUnsubscribeData(
          pty.onData((payload: { sid: string; chunk: string }) => {
            if (payload.sid !== getActiveSid()) return;
            getTerm()?.write(payload.chunk);
          }),
        );

        const t3 = getTerm();
        if (t3) {
          setInputDisposable(
            t3.onData((data: string) => {
              const sid = getActiveSid();
              if (sid) window.ccsmPty.input(sid, data);
            }),
          );
        }

        // Push the current container size to the backend so claude
        // re-wraps to the visible viewport rather than the spawn-time cols/rows.
        const fit = getFit();
        const t4 = getTerm();
        const sid4 = getActiveSid();
        if (fit && t4 && sid4) {
          try {
            fit.fit();
            window.ccsmPty.resize(sid4, t4.cols, t4.rows);
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
        const t5 = getTerm();
        if (t5) {
          try {
            t5.focus();
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
  }, [sessionId, attachNonce, cwd]);

  // pty:exit subscription for the active session → flip to exit state with
  // a classification (clean vs crashed) shared with the store via
  // `classifyPtyExit` (src/lib/ptyExitClassifier.ts), so the active-pane
  // overlay and the sidebar red-dot signal stay consistent.
  useEffect(() => {
    const pty = window.ccsmPty;
    if (!pty?.onExit) return;
    const unsubscribe = pty.onExit(
      (evt: { sessionId: string; code?: number | null; signal?: string | number | null }) => {
        if (evt.sessionId !== getActiveSid()) return;
        const signal = evt.signal ?? null;
        const code = evt.code ?? null;
        const exitKind = classifyPtyExit({ code, signal });
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
      } catch {
        // already torn down — safe to ignore.
      }
    };
  }, []);

  const onRetry = useCallback(() => {
    setAttachNonce((n) => n + 1);
  }, []);

  return { state, onRetry };
}
