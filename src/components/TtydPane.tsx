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

type Props = {
  sessionId: string;
  cwd: string;
  /**
   * Monotonic counter incremented by App whenever the user explicitly
   * intends "I want to type into the CLI now" — currently bumped on
   * new-session creation (sidebar button, command palette, Ctrl+N,
   * first-run CTA, tutorial). When this changes we focus the embedded
   * webview AND the xterm helper textarea inside it.
   *
   * Why a nonce instead of a focus event bus: the focus intent is local
   * to App ↔ TtydPane and tied to React state changes; a counter prop
   * keeps the dataflow trivially traceable and survives React StrictMode
   * double-invocation without spurious focus jumps (we only act when
   * the value actually changes from the previously-honored one).
   *
   * We deliberately do NOT auto-focus on every sessionId change —
   * switching to an existing session keeps the user's prior focus
   * context (e.g. arrow-key navigation in the sidebar).
   */
  focusRequestNonce?: number;
};

type State =
  | { kind: 'loading' }
  | { kind: 'ready'; port: number }
  | { kind: 'error'; message: string };

// Electron <webview> exposes `focus()` and `executeJavaScript()`; we
// only call those two so we don't pull in @types/electron just for this.
type WebviewElement = HTMLElement & {
  focus: () => void;
  executeJavaScript: (code: string) => Promise<unknown>;
  addEventListener: HTMLElement['addEventListener'];
  removeEventListener: HTMLElement['removeEventListener'];
};

export function TtydPane({ sessionId, cwd, focusRequestNonce }: Props) {
  const [state, setState] = useState<State>({ kind: 'loading' });
  // Track the sessionId we requested for so a stale resolve from a
  // previous session can't clobber the current one when the user
  // switches quickly.
  const activeSidRef = useRef<string>(sessionId);
  const webviewRef = useRef<WebviewElement | null>(null);
  // Track which nonces we've already honored so re-renders (state flips,
  // sessionId switches) don't re-fire focus for the same intent.
  const honoredNonceRef = useRef<number | undefined>(undefined);
  // Whether the current webview's `dom-ready` has fired. Focusing a
  // webview before its underlying webContents is attached is a no-op,
  // and `executeJavaScript` rejects, so we queue the focus and flush on
  // dom-ready.
  const domReadyRef = useRef<boolean>(false);
  // Pending focus request that arrived before dom-ready (or before the
  // webview element existed). Flushed once both conditions hold.
  const pendingFocusRef = useRef<boolean>(false);

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

  // Focus orchestration. We focus the webview itself AND
  // `document.querySelector('.xterm-helper-textarea')` inside the webview
  // — xterm.js routes keyboard input through that hidden textarea, so
  // focusing the webview alone leaves the cursor un-blinking and the
  // first keystroke gets dropped.
  //
  // The xterm helper textarea is constructed AFTER dom-ready (the page
  // has to download xterm.js, mount Terminal, then xterm injects the
  // textarea). A single executeJavaScript right at dom-ready often hits
  // a null selector. We retry on a short backoff so the focus actually
  // lands inside xterm rather than only on the host webview tag (which
  // forwards key events but leaves the cursor non-blinking and the
  // first keystroke discarded by xterm's own focus gate).
  const flushFocus = useCallback(() => {
    const wv = webviewRef.current;
    if (!wv || !domReadyRef.current) return;
    pendingFocusRef.current = false;
    try {
      wv.focus();
    } catch {
      // focus() can throw if the webview was just detached; ignore
      // — the next nonce bump will retry.
    }
    // Retry the helper-textarea focus a few times — xterm constructs
    // the textarea asynchronously after the embedded page loads, so
    // the first call (right at dom-ready) usually misses.
    void wv
      .executeJavaScript(
        `(function(){
          const tryFocus = (attemptsLeft) => {
            const el = document.querySelector('.xterm-helper-textarea');
            if (el) { el.focus(); return true; }
            if (attemptsLeft <= 0) return false;
            setTimeout(() => tryFocus(attemptsLeft - 1), 100);
            return false;
          };
          return tryFocus(20);
        })();`,
      )
      .catch(() => {});
  }, []);

  // Honor a new focus request when the nonce changes. If the webview
  // hasn't finished `dom-ready` yet, queue it — the dom-ready listener
  // (set on the webview element via `ref`) will flush.
  useEffect(() => {
    if (focusRequestNonce === undefined) return;
    if (honoredNonceRef.current === focusRequestNonce) return;
    honoredNonceRef.current = focusRequestNonce;
    pendingFocusRef.current = true;
    flushFocus();
  }, [focusRequestNonce, flushFocus]);

  // When sessionId changes the webview src changes too → dom-ready will
  // fire again. Reset the gate so the next focus request waits for the
  // new attach instead of false-firing on the stale flag.
  useEffect(() => {
    domReadyRef.current = false;
  }, [sessionId]);

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
      ref={(el: HTMLElement | null) => {
        const wv = el as WebviewElement | null;
        if (webviewRef.current === wv) return;
        // Tear down listener on the previous element, if any.
        type WithHandler = WebviewElement & { __ccsmDomReadyHandler?: (e: Event) => void };
        const prev = webviewRef.current as WithHandler | null;
        if (prev && prev.__ccsmDomReadyHandler) {
          prev.removeEventListener('dom-ready', prev.__ccsmDomReadyHandler);
        }
        webviewRef.current = wv;
        if (!wv) return;
        const handler = () => {
          domReadyRef.current = true;
          if (pendingFocusRef.current) flushFocus();
        };
        // Stash the handler on the element so the next ref callback
        // can detach it precisely (we need a stable reference for
        // removeEventListener).
        (wv as WithHandler).__ccsmDomReadyHandler = handler;
        wv.addEventListener('dom-ready', handler);
      }}
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
