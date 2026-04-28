import { useCallback, useEffect, useRef, useState } from 'react';

// TtydPane mounts a per-session Electron <webview> that points at the ttyd
// HTTP server spawned by the main-process cliBridge. Each session owns its
// own ttyd instance on a dedicated 127.0.0.1 port; this component is the
// renderer-side view onto that pairing.
//
// Why <webview> and not <iframe>: the plain iframe path leaves the embedded
// claude TUI black on Windows because the host BrowserWindow's contextIsolation
// + sandbox combo interferes with ttyd's xterm WebSocket. <webview> hosts
// the page in an out-of-process Chromium frame with its own session — this
// matches the working spike (`spike/ttyd-embed/main.js` + `index.html`) where
// the same ttyd binary renders correctly. Requires `webviewTag: true` on the
// host BrowserWindow's webPreferences (set in electron/main.ts).
//
// Lifecycle (per sessionId):
//   1. mount / sessionId change → if a ttyd is already running for the
//      session (user previously opened it this app-launch), reuse its
//      port instead of spawning. Otherwise openTtydForSession to spawn.
//   2. on ok → render <iframe src="http://127.0.0.1:<port>/">
//   3. on error or ttyd-exit for this sid → flip to error state w/ Retry
//   4. unmount / sessionId change → DO NOT kill. ttyd lifecycle is owned
//      by the ccsm session itself (created here, destroyed on
//      deleteSession). Killing on unmount would tear down the chat the
//      moment the user navigates away — and on switch-back we'd need to
//      respawn from scratch, losing all in-memory context.
//
// Strings are intentionally hardcoded English placeholders for now; W2c
// will swap them for i18n keys when wiring this into App.

type Props = { sessionId: string; cwd: string };

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; port: number }
  | { kind: 'error'; message: string };

export function TtydPane({ sessionId, cwd }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Track the sessionId we requested for so a stale resolve from a
  // previous session can't clobber the current one when the user
  // switches quickly.
  const activeSidRef = useRef<string>(sessionId);

  const open = useCallback(async (sid: string, sessionCwd: string) => {
    const bridge = window.ccsmCliBridge;
    if (!bridge) {
      setState({ kind: 'error', message: 'cliBridge unavailable' });
      return;
    }
    setState({ kind: 'loading' });
    try {
      // Reuse-first: if main already has a running ttyd for this session
      // (reopened tab, switch-back, etc.) attach to its port directly so
      // the existing claude conversation continues without restart.
      const existing = await bridge.getTtydForSession?.(sid).catch(() => null);
      if (activeSidRef.current !== sid) return;
      if (existing) {
        setState({ kind: 'ready', port: existing.port });
        return;
      }
      const res = await bridge.openTtydForSession(sid, sessionCwd);
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

  // Mount / sessionId change: open (or reuse) the new session's ttyd.
  // Cleanup intentionally does NOT kill — see the lifecycle note above.
  useEffect(() => {
    activeSidRef.current = sessionId;
    void open(sessionId, cwd);
  }, [sessionId, cwd, open]);

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
          onClick={() => void open(sessionId, cwd)}
          className="px-3 py-1 rounded border border-neutral-700 text-neutral-200 hover:bg-neutral-800 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400"
        >
          Retry
        </button>
      </div>
    );
  }

  return (
    // Electron's <webview> tag is not in React's intrinsic JSX namespace,
    // but React DOM passes through unknown lowercase tags as custom
    // elements. The attributes mirror the working spike's index.html
    // (allowpopups, partition). `partition="persist:ttyd"` isolates
    // webview storage from the host BrowserWindow and makes Electron
    // treat this as a real out-of-process webview rather than an iframe.
    <webview
      src={`http://127.0.0.1:${state.port}/`}
      // bg matches the ttyd `-t theme=...` background so the seam
      // between host chrome and the embedded TUI is intentional rather
      // than off-by-a-shade. The faint inner ring gives the user a
      // visible boundary without competing with content.
      className="flex-1 w-full h-full border-0 bg-[#0B0B0C] ring-1 ring-inset ring-white/5"
      // eslint-disable-next-line react/no-unknown-property -- Electron <webview> tag attribute, not a standard HTML prop
      partition="persist:ttyd"
      title={`ttyd session ${sessionId}`}
    />
  );
}

export default TtydPane;
