// `usePtyAttach.ts` — the single PTY-attach path for the renderer.
//
// Replaces the legacy `usePtyAttach.warm.ts` 19-step state machine with a
// dead-simple contract that mirrors the design doc (docs/attach-redesign.html):
//
//   * `getShell(sid)` returns non-null → second-or-later click on a session
//     we've already seen. Pure `showShell(sid)` — z-stack flip, no IPC, no
//     mask, no rebuild. Renders `ready` immediately.
//
//   * `getShell(sid)` returns null → first click on this session. Show the
//     "preparing" mask, run `createShell` (which subscribes PTY + opens
//     xterm + writes snapshot + scrolls to bottom), then reveal.
//
// The hook also owns the per-host ResizeObserver-driven snapshot replay
// (host dims changed — claude's alt-screen TUI won't repaint until next
// input, so we pull a fresh snapshot) and the PTY-exit watcher (a hidden
// session that crashes lands in `disconnectedSessions[sid]`; we flip the
// local state to `exit` when the user switches back).

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from '../stores/store';
import { warn, log } from '../shared/log';
import {
  createShell,
  disposeShell,
  getShell,
  resizeReplay,
  showShell,
  type ShellState,
} from './shellRegistry';

export type PtyAttachState = ShellState;

export type UsePtyAttachResult = {
  state: PtyAttachState;
  onRetry: () => void;
};

/**
 * Single PTY-attach hook for the renderer. See module header.
 *
 * `hostRef` is the host div from TerminalPane. The shell's wrapper is
 * parented under that host on first show; the mask (see TerminalPane's
 * "Preparing..." overlay) is a SIBLING of the wrapper rendered by React.
 * The hook drives `state`, the component reads `state.kind === 'cold-starting'`
 * to render the mask.
 */
export function usePtyAttach(
  sessionId: string,
  cwd: string,
  hostRef: { current: HTMLDivElement | null },
): UsePtyAttachResult {
  const [state, _setState] = useState<PtyAttachState>(() =>
    getShell(sessionId) ? { kind: 'ready' } : { kind: 'cold-starting' },
  );
  const requestedSidRef = useRef<string>(sessionId);
  const setState = useCallback(
    (next: PtyAttachState, reason?: string): void => {
      _setState((prev) => {
        try {
          log.event('attach.state.transition', {
            sid: requestedSidRef.current,
            from: prev.kind,
            to: next.kind,
            reason: reason ?? next.kind,
          });
        } catch {
          /* probe failure must not break the state machine */
        }
        return next;
      });
    },
    [],
  );
  const clearPtyExit = useStore((s) => s._clearPtyExit);
  const clearPtyExitRef = useRef(clearPtyExit);
  clearPtyExitRef.current = clearPtyExit;
  const [attachNonce, setAttachNonce] = useState(0);
  const reloadNonce = useStore((s) => s.reloadNonce?.[sessionId] ?? 0);

  useEffect(() => {
    requestedSidRef.current = sessionId;
    let cancelled = false;

    const host = hostRef.current;
    if (!host) {
      setState({ kind: 'error', message: 'no-host' }, 'no-host');
      return;
    }
    const existing = getShell(sessionId);
    if (existing) {
      // Already seen — pure DOM flip, no IPC. The shell's wrapper is
      // under the host's layout tree (parented at create time, never
      // reparented), so showShell just toggles display + z-index.
      // Sub-frame, no perceptible delay.
      showShell(sessionId);
      // If a backgrounded crash already populated `disconnectedSessions`,
      // the exit-watch effect below picks it up immediately on next render.
      const exitInfo = useStore.getState().disconnectedSessions[sessionId];
      if (exitInfo) {
        const detail =
          exitInfo.signal != null
            ? `signal ${exitInfo.signal}`
            : exitInfo.code != null
              ? `exit code ${exitInfo.code}`
              : 'unknown';
        setState(
          { kind: 'exit', exitKind: exitInfo.kind, detail },
          'show-found-existing-exit',
        );
      } else {
        setState({ kind: 'ready' }, 'show-existing');
      }
      return;
    }

    // Cold start. Mark state so the component renders the mask, then run
    // the build-shell pipeline. createShell awaits the full
    // subscribe/attach/snapshot/write/scrollToBottom chain and only then
    // calls showShell. By the time createShell resolves, the mask can come
    // down because the terminal is fully painted underneath.
    setState({ kind: 'cold-starting' }, 'cold-start-begin');

    const forkSourceSid =
      useStore.getState().pendingForkSource[sessionId] ?? undefined;

    (async () => {
      const result = await createShell(sessionId, host, cwd, forkSourceSid);
      if (forkSourceSid) {
        useStore.setState((s) => {
          if (!s.pendingForkSource[sessionId]) return {};
          const next = { ...s.pendingForkSource };
          delete next[sessionId];
          return { pendingForkSource: next };
        });
      }
      if (cancelled || requestedSidRef.current !== sessionId) {
        // User switched away mid-cold-start. Tear down the half-built
        // shell — no point keeping a never-shown one around, and the
        // router would be stuck in a stale state on next attach.
        disposeShell(sessionId, 'retry');
        return;
      }
      if (result.kind === 'ready') {
        clearPtyExitRef.current(sessionId);
        setState({ kind: 'ready' }, 'cold-start-complete');
      } else {
        setState(result, 'cold-start-result');
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [sessionId, cwd, attachNonce, reloadNonce, setState, hostRef]);

  // PTY exit watcher — fires when a session (visible OR hidden) crashes.
  const disconnect = useStore((s) => s.disconnectedSessions[sessionId]);
  useEffect(() => {
    if (!disconnect) return;
    const detail =
      disconnect.signal != null
        ? `signal ${disconnect.signal}`
        : disconnect.code != null
          ? `exit code ${disconnect.code}`
          : 'unknown';
    setState({ kind: 'exit', exitKind: disconnect.kind, detail }, 'pty-exit-watched');
  }, [disconnect, setState]);

  // Host-resize → snapshot replay. claude TUI doesn't repaint on
  // SIGWINCH until next user input, so we pull a fresh snapshot when the
  // host's dimensions actually change (gated on contentRect delta so
  // display:'' flips don't trigger spurious replays). 80ms debounce so
  // a continuous drag fires one replay per pause.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let debounce: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let replayInFlight = false;
    let replayPending = false;

    const scheduleReplay = (): void => {
      if (replayInFlight) {
        replayPending = true;
        return;
      }
      replayInFlight = true;
      void (async () => {
        try {
          await resizeReplay(sessionId);
          while (replayPending && !cancelled) {
            replayPending = false;
            await resizeReplay(sessionId);
          }
        } finally {
          replayInFlight = false;
          replayPending = false;
        }
      })();
    };

    let lastW = 0;
    let lastH = 0;
    let baseline = false;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (!baseline) {
        lastW = w;
        lastH = h;
        baseline = true;
        return;
      }
      if (w === lastW && h === lastH) return;
      lastW = w;
      lastH = h;
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(scheduleReplay, 80);
    });
    ro.observe(host);
    return () => {
      cancelled = true;
      if (debounce) clearTimeout(debounce);
      ro.disconnect();
    };
  }, [sessionId, hostRef]);

  const onRetry = useCallback(() => {
    try {
      disposeShell(sessionId, 'retry');
    } catch (e) {
      warn('attach', 'disposeShell on retry failed', e);
    }
    try {
      clearPtyExitRef.current(sessionId);
    } catch {
      /* slice may be absent in tests */
    }
    setState({ kind: 'cold-starting' }, 'retry');
    setAttachNonce((n) => n + 1);
  }, [sessionId, setState]);

  return { state, onRetry };
}
