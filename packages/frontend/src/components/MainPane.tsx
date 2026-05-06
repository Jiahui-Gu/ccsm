import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { createSession } from '../api/sessions';
import { WsClient } from '../ws/client';
import { useStore } from '../store';

// MainPane owns the single xterm instance and the ws lifecycle for the active
// session. T6 scope: auto-create one session on mount, attach ws, wire I/O,
// surface EXIT and disconnect as inline notices.
//
// Sidebar (T5) is intentionally untouched — its + New Session button stays
// placeholder until T9/T10 introduces real multi-session UX.
//
// StrictMode contract (P1-3 re-fix):
//   React 18+ StrictMode dev-mode mounts every effect twice (mount → cleanup →
//   re-mount) to surface non-idempotent code. Three invariants must hold:
//
//   1. The xterm Terminal is a *renderer-owned* DOM resource. We MUST create
//      it inside the effect body and dispose it in cleanup; otherwise the
//      first cleanup detaches it from the DOM and the second mount has no
//      terminal, leaving MainPane permanently blank in dev.
//
//   2. The ws bootstrap (POST /api/sessions + WsClient.connect()) is a
//      *server-side* side-effect. Running it twice would orphan one PTY on
//      the daemon. We guard it with `bootstrappedRef` (never reset) so the
//      second mount short-circuits.
//
//   3. The bridge between (1) and (2): WsClient was constructed with callbacks
//      that captured the FIRST terminal. After the StrictMode remount that
//      terminal is disposed. We thread all writes through `termRef.current`
//      (a ref *survives* StrictMode's mount/unmount cycle on the same
//      component instance), so the long-lived WsClient always writes into the
//      currently-mounted terminal — not the disposed one.
export function MainPane() {
  const containerRef = useRef<HTMLDivElement>(null);
  // Guards the ws bootstrap (POST + connect) — the only side-effect that must
  // run exactly once per component lifetime. Never reset on cleanup.
  const bootstrappedRef = useRef(false);
  // Holds the live WsClient across StrictMode's mount/unmount cycle so the
  // second mount does not create a duplicate session.
  const clientRef = useRef<WsClient | null>(null);
  // Always points at the *currently mounted* Terminal so the WsClient (whose
  // callbacks were bound on mount #1) writes into the new term after a
  // StrictMode remount instead of the disposed one.
  const termRef = useRef<Terminal | null>(null);
  const setSid = useStore((s) => s.setSid);
  const setStatus = useStore((s) => s.setStatus);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // ---- xterm: renderer-owned, rebuilt on every mount ----
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

    // After a StrictMode remount the WsClient already exists and is still
    // connected (we don't close it in cleanup — see below). Push the new
    // viewport so the daemon resizes the PTY to whatever the freshly-built
    // Terminal reports.
    if (clientRef.current) {
      clientRef.current.sendResize(term.cols, term.rows);
    }

    // NOTE on cancellation: we deliberately do NOT cancel the in-flight
    // bootstrap on cleanup. Under StrictMode, mount #1 starts the bootstrap,
    // cleanup #1 fires *immediately*, then mount #2 short-circuits the guard.
    // If we set `cancelled = true` in cleanup #1, the bootstrap would resolve
    // into a no-op and no WsClient would ever be created. The bootstrap is
    // safe to run to completion: setSid writes to a module-level zustand
    // store that survives remounts, and the resulting WsClient lives in
    // clientRef which also survives the StrictMode cycle.

    // ---- mount #1: bootstrap session + ws (guarded against StrictMode) ----
    if (!bootstrappedRef.current) {
      bootstrappedRef.current = true;
      const token = sessionStorage.getItem('ccsm.token');
      if (!token) {
        writeNoticeTo(term, '[no token in URL — append ?token=<t> and reload]');
      } else {
        // Fire-and-forget bootstrap. Errors are surfaced inline; we don't throw
        // out of the effect because React would just swallow it.
        const decoder = new TextDecoder();
        void (async () => {
          try {
            const { sid } = await createSession(token);
            setSid(sid);
            // All callbacks route through termRef.current so they survive a
            // StrictMode remount: the original `term` may already be disposed
            // by the time output arrives, but termRef points at the live one.
            const client = new WsClient({
              sid,
              token,
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
            client.connect();
            // Push the initial size so the daemon spawns the PTY at the real
            // viewport, not the node-pty default 80x24. WsClient buffers this
            // until the socket reaches OPEN.
            client.sendResize(term.cols, term.rows);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const t = termRef.current;
            if (t) writeNoticeTo(t, `[failed to create session: ${msg}]`);
          }
        })();
      }
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
        // FitAddon throws if the container is detached; ignore during teardown.
      }
    };
    window.addEventListener('resize', onWindowResize);

    return () => {
      window.removeEventListener('resize', onWindowResize);
      inputDisp.dispose();
      resizeDisp.dispose();
      // Clear termRef BEFORE disposing so any in-flight WsClient callback
      // (e.g. an OUTPUT frame mid-decode) hits the null branch instead of
      // writing into a half-disposed Terminal.
      if (termRef.current === term) {
        termRef.current = null;
      }
      term.dispose();
      // NOTE: we deliberately do NOT close clientRef.current here. The client
      // is the long-lived ws connection; closing it on every StrictMode
      // unmount would tear down the session immediately after creating it.
      // The browser will GC the WsClient when the component truly unmounts
      // (route change / tab close), at which point the underlying WebSocket
      // is closed by the runtime.
    };
    // useStore selectors are stable refs from zustand; effect runs once per
    // mount cycle (twice total under StrictMode dev double-invoke).
  }, [setSid, setStatus]);

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
  // ANSI dim + newline so the notice is visible but doesn't pollute output.
  term.write(`\r\n\x1b[2m${msg}\x1b[22m\r\n`);
}
