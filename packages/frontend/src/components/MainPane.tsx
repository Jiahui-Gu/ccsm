import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { createSession } from '../api/sessions';
import { WsClient } from '../ws/client';
import { useStore } from '../store';

// MainPane (Task #656 / T9 — DESIGN.md §7).
//
// Owns ONE xterm instance and ONE WsClient at any time, attached to the
// store's `activeSid`. T9 trade-off versus the §7 ideal: switching activeSid
// tears the ws + xterm down and rebuilds for the new sid. Per-session
// background ws + scrollback restoration is T10 (#662) — explicitly out of
// scope here. Manager-spec: "scrollback 丢失是预期的, T10 才真正做保留".
//
// LIFECYCLE INVARIANTS:
//
//   1. Bootstrap is one-shot.
//      On the very first mount with a token in sessionStorage and an empty
//      session list, MainPane fires POST /api/sessions and addSession()s the
//      result (which auto-promotes it to active). The `bootstrappedRef` guard
//      survives StrictMode dev double-invoke so the POST happens exactly
//      once, matching the T6 strictmode-regression assertion.
//
//   2. xterm is renderer-owned.
//      The Terminal is constructed inside the effect body and disposed in
//      cleanup. Under StrictMode the first cleanup disposes mount #1's
//      terminal; mount #2 must rebuild a fresh one or MainPane goes blank.
//      We thread writes through `termRef.current` so any in-flight WsClient
//      callback always lands in the *currently mounted* terminal.
//
//   3. WsClient is ALSO scoped to (mount-cycle × activeSid).
//      Unlike T6 (where the ws survived StrictMode for a single session),
//      T9 must rebuild the ws every time activeSid changes. We keep the
//      "don't close on StrictMode unmount" trick by stashing the desired
//      sid in `clientSidRef` and only tearing down when the *next* effect
//      run is for a different sid (or activeSid is null). Pure StrictMode
//      remount within the same activeSid still skips the close, so the T6
//      strictmode contract continues to hold.
//
//   4. Bootstrap path uses a synthetic local sid for the StrictMode guard.
//      We mark `bootstrappedRef = true` *before* the await so the second
//      StrictMode mount short-circuits, exactly the way T6 did it.

export function MainPane() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Bootstrap guard — never reset on cleanup. Survives StrictMode.
  const bootstrappedRef = useRef(false);

  // Active WsClient (scoped to current activeSid). Survives StrictMode
  // remount within the same sid; replaced when activeSid changes.
  const clientRef = useRef<WsClient | null>(null);
  const clientSidRef = useRef<string | null>(null);

  // Always points at the currently mounted Terminal so long-lived ws
  // callbacks survive StrictMode's mount/unmount cycle.
  const termRef = useRef<Terminal | null>(null);

  const token = useStore((s) => s.token);
  const sessions = useStore((s) => s.sessions);
  const activeSid = useStore((s) => s.activeSid);
  const addSession = useStore((s) => s.addSession);
  const setStatus = useStore((s) => s.setStatus);

  // Token resolution: prefer the store cache, but fall back to sessionStorage
  // at action-time. The store eagerly snapshots sessionStorage at module load
  // (main.tsx writes the token before React mounts), but unit tests stash the
  // token in beforeEach *after* the store module evaluated, so reading from
  // the live sessionStorage keeps both paths working without forcing every
  // test to also call `useStore.setState({ token })`.
  const resolveToken = (): string | null => {
    if (token) return token;
    if (typeof window === 'undefined') return null;
    return sessionStorage.getItem('ccsm.token');
  };

  // ---- bootstrap effect ----
  //
  // Auto-create the first session when the page loads with no sessions in
  // the store. This preserves the T6 UX ("open page → terminal attaches")
  // without requiring the user to click + New Session manually. The Sidebar
  // + New Session button drives the *subsequent* sessions through the same
  // store API (addSession), so this effect only ever fires once per page
  // lifetime.
  useEffect(() => {
    if (bootstrappedRef.current) return;
    const tok = resolveToken();
    if (!tok) return;
    if (sessions.length > 0) return;

    bootstrappedRef.current = true;
    void (async () => {
      try {
        const resp = await createSession(tok);
        const createdAt =
          typeof resp.createdAt === 'number' ? resp.createdAt : Date.now();
        addSession({ sid: resp.sid, createdAt, alive: true });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // Reset the guard so the user can click + New Session and retry —
        // we only intended to one-shot the *automatic* bootstrap.
        bootstrappedRef.current = false;
        const t = termRef.current;
        if (t) writeNoticeTo(t, `[failed to create session: ${msg}]`);
      }
    })();
  }, [sessions.length, addSession]);

  // ---- xterm + ws effect (re-runs on activeSid change) ----
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const tok = resolveToken();

    // Always rebuild the xterm: it is renderer-owned. StrictMode dev cleanup
    // disposes the first one; we need a fresh Terminal for mount #2 anyway.
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: 'Menlo, Consolas, "Liberation Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#0d0d0d',
        foreground: '#e5e5e5',
      },
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(container);
    try {
      fitAddon.fit();
    } catch {
      // jsdom and other zero-layout environments throw on fit(); harmless.
    }
    termRef.current = term;

    // ---- ws lifecycle ----
    if (!activeSid) {
      // No session selected (initial load before bootstrap, or after the
      // user closed the last session). Show a hint and skip ws setup.
      writeNoticeTo(term, '[no active session — click + New Session]');
    } else if (!tok) {
      writeNoticeTo(term, '[no token in URL — append ?token=<t> and reload]');
    } else if (clientRef.current && clientSidRef.current === activeSid) {
      // Same sid as the previous mount cycle — this is a StrictMode remount,
      // not a real session switch. Reuse the existing ws (T6 invariant) and
      // just push the new viewport so node-pty matches the freshly built
      // Terminal.
      clientRef.current.sendResize(term.cols, term.rows);
    } else {
      // Real switch to a new sid (or first attach for the very first sid).
      // Tear down the previous ws if any, then open a fresh one.
      if (clientRef.current) {
        try {
          clientRef.current.close();
        } catch {
          // close() is already best-effort; ignore.
        }
        clientRef.current = null;
        clientSidRef.current = null;
      }
      const sid = activeSid;
      const decoder = new TextDecoder();
      const client = new WsClient({
        sid,
        token: tok,
        // All callbacks route through termRef.current so they survive a
        // StrictMode remount: the original `term` may already be disposed
        // by the time output arrives, but termRef points at the live one.
        onOutput: (data) => {
          const t = termRef.current;
          if (t) t.write(decoder.decode(data, { stream: true }));
        },
        onExit: (code) => {
          const t = termRef.current;
          if (t) writeNoticeTo(t, `[session exited code=${code}]`);
        },
        onDisconnect: (reason) => {
          const t = termRef.current;
          if (t) writeNoticeTo(t, `[disconnected: ${reason}]`);
        },
        onStatusChange: (s) => setStatus(s),
      });
      clientRef.current = client;
      clientSidRef.current = sid;
      client.connect();
      // Push the initial size so the daemon spawns the PTY at the real
      // viewport, not the node-pty default 80x24.
      client.sendResize(term.cols, term.rows);
    }

    const inputDisp = term.onData((data) => {
      clientRef.current?.sendInput(data);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      clientRef.current?.sendResize(cols, rows);
    });

    const onWindowResize = (): void => {
      try {
        fitAddon.fit();
      } catch {
        // FitAddon throws if the container is detached; ignore.
      }
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
      inputDisp.dispose();
      resizeDisp.dispose();
      // Clear termRef BEFORE disposing so any in-flight ws callback hits
      // the null branch instead of writing into a half-disposed Terminal.
      if (termRef.current === term) {
        termRef.current = null;
      }
      term.dispose();
      // NOTE: we deliberately DO NOT close clientRef.current on cleanup.
      // Two reasons:
      //   - StrictMode dev double-mount: closing here would tear down the
      //     ws right after creating it (the T6 regression we keep guarding).
      //   - Real activeSid change: the *next* effect run handles the close
      //     in the "real switch" branch, after deciding whether the new sid
      //     differs from the cached one. Doing it here would lose that
      //     comparison and force a needless reconnect on every rerender.
    };
  }, [activeSid, token, setStatus]);

  return (
    <div className="main-pane">
      <div
        id="terminal"
        ref={containerRef}
        className="main-pane__terminal"
        data-testid="main-terminal"
      />
    </div>
  );
}

// Module-scope helper so the closures above don't each capture a fresh copy.
function writeNoticeTo(term: Terminal, msg: string): void {
  term.write(`\r\n\x1b[2m${msg}\x1b[22m\r\n`);
}
