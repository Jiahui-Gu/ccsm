import { useCallback, useEffect, useRef, useState } from 'react';

// TtydPane mounts a per-session iframe that points at the ttyd HTTP
// server spawned by the main-process cliBridge. Each session owns its
// own ttyd instance on a dedicated 127.0.0.1 port; this component is the
// renderer-side lifecycle owner for that pairing.
//
// Lifecycle (per sessionId):
//   1. mount / sessionId change → openTtydForSession(sid)
//   2. on ok → render <iframe src="http://127.0.0.1:<port>/">
//   3. on error or ttyd-exit for this sid → flip to error state w/ Retry
//   4. unmount / sessionId change → killTtydForSession(prevSid)
//
// Strings are intentionally hardcoded English placeholders for now; W2c
// will swap them for i18n keys when wiring this into App.

type Props = { sessionId: string };

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; port: number }
  | { kind: 'error'; message: string };

export function TtydPane({ sessionId }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Track the sessionId we requested for so a stale resolve from a
  // previous session can't clobber the current one when the user
  // switches quickly.
  const activeSidRef = useRef<string>(sessionId);

  const open = useCallback(async (sid: string) => {
    const bridge = window.ccsmCliBridge;
    if (!bridge) {
      setState({ kind: 'error', message: 'cliBridge unavailable' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      const res = await bridge.openTtydForSession(sid);
      if (activeSidRef.current !== sid) return; // session switched mid-flight
      if (res.ok) {
        setState({ kind: 'ready', port: res.port });
      } else {
        setState({ kind: 'error', message: res.error });
      }
    } catch (err) {
      if (activeSidRef.current !== sid) return;
      const message = err instanceof Error ? err.message : String(err);
      setState({ kind: 'error', message });
    }
  }, []);

  // Mount / sessionId change: open the new session, kill the previous on
  // cleanup. Effect cleanup runs before the next effect for the new sid,
  // so prevSid is always the one we opened.
  useEffect(() => {
    activeSidRef.current = sessionId;
    void open(sessionId);
    const prevSid = sessionId;
    return () => {
      window.ccsmCliBridge?.killTtydForSession(prevSid).catch(() => {
        // best-effort cleanup; main process will reap on quit anyway
      });
    };
  }, [sessionId, open]);

  // Subscribe to ttyd-exit broadcasts so an unexpected backend death
  // flips us into the error state with a Retry affordance.
  useEffect(() => {
    const bridge = window.ccsmCliBridge;
    if (!bridge?.onTtydExit) return;
    const unsubscribe = bridge.onTtydExit((evt) => {
      if (evt.sessionId !== activeSidRef.current) return;
      const detail =
        evt.signal != null
          ? `signal ${evt.signal}`
          : evt.code != null
            ? `exit code ${evt.code}`
            : 'unknown reason';
      setState({ kind: 'error', message: `ttyd exited (${detail})` });
    });
    return unsubscribe;
  }, []);

  if (state.kind === 'loading') {
    return (
      <div className="flex items-center justify-center h-full text-neutral-400 text-sm">
        Starting...
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3 text-sm">
        <div className="text-red-400 max-w-md text-center break-words px-4">
          {state.message}
        </div>
        <button
          type="button"
          onClick={() => void open(sessionId)}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    <iframe
      src={`http://127.0.0.1:${state.port}/`}
      className="flex-1 w-full h-full border-0 bg-black"
      title={`ttyd session ${sessionId}`}
    />
  );
}

export default TtydPane;
