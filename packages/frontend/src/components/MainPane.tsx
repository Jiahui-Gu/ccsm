import { useEffect, useRef } from 'react';
import { Terminal } from 'xterm';
import { FitAddon } from 'xterm-addon-fit';
import 'xterm/css/xterm.css';
import { createSession } from '../api/sessions';
import { sessionRuntime } from '../session-runtime';
import { useStore } from '../store';

// MainPane (Task #662 / T10 — DESIGN.md §7).
//
// T10 RESHAPE OF T9:
//   T9 owned the WsClient inside MainPane, which made switching activeSid
//   tear the ws down (and thus lose scrollback). T10 moves all per-session
//   ws + scrollback state into `session-runtime.ts` (a non-React singleton),
//   so a session's bytes keep flowing into its scrollback even when the
//   user is looking at a different session. MainPane now only:
//     1. owns ONE xterm instance (renderer-side concern),
//     2. attaches each known sid to the runtime (idempotent),
//     3. on activeSid change, clears xterm and replays the new sid's
//        scrollback from the runtime,
//     4. subscribes to the runtime's OUTPUT/RESET pub-sub and writes only
//        the active sid's bytes into xterm in real time.
//
// LIFECYCLE INVARIANTS (preserved from T9):
//
//   - Bootstrap is one-shot (StrictMode dev double-invoke must not
//     double-POST /api/sessions).
//   - xterm is renderer-owned: rebuilt on each effect run, threaded through
//     `termRef` so long-lived runtime listeners always write into the
//     currently-mounted Terminal.
//   - Runtime entries OUTLIVE the React effect cycle (that's the whole
//     point of T10): we never call `sessionRuntime.detach()` on cleanup.
//     Detach happens only when the user closes the row from the sidebar.

export function MainPane() {
  const containerRef = useRef<HTMLDivElement>(null);

  // Bootstrap guard — never reset on cleanup. Survives StrictMode.
  const bootstrappedRef = useRef(false);

  // Always points at the currently mounted Terminal so long-lived runtime
  // listeners survive StrictMode's mount/unmount cycle.
  const termRef = useRef<Terminal | null>(null);
  // Mirrors the rendered activeSid for the runtime listener (which lives
  // outside React state). Updated synchronously inside the effect.
  const activeSidRef = useRef<string | null>(null);

  const token = useStore((s) => s.token);
  const sessions = useStore((s) => s.sessions);
  const activeSid = useStore((s) => s.activeSid);
  const addSession = useStore((s) => s.addSession);

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

  // ---- runtime output listener (mounted once, lives forever) ----
  //
  // Subscribed in a layout-time effect with empty deps so it survives
  // StrictMode remount AND every activeSid change. The listener consults
  // `activeSidRef` + `termRef` at call time, so flipping the active sid
  // requires no resubscribe.
  //
  // T11 #654 backpressure: when we DO write into xterm, we sandwich the
  // write between `notePendingWrite` (before) and `noteWriteFlushed` (in
  // the flush callback). That gives the runtime an in-flight queue depth
  // it uses to decide PAUSE/RESUME. Non-active sids return early below
  // (their bytes are already in scrollback) so they never participate in
  // backpressure — only the rendering subscriber gates the daemon.
  useEffect(() => {
    const unsubscribe = sessionRuntime.subscribeOutput((sid, payload) => {
      if (sid !== activeSidRef.current) return;
      const t = termRef.current;
      if (!t) return;
      if (payload === null) {
        // RESET — runtime already wiped its scrollback; mirror that into
        // xterm so on-screen content matches the empty buffer.
        t.reset();
        return;
      }
      sessionRuntime.notePendingWrite(sid);
      t.write(new TextDecoder().decode(payload, { stream: true }), () => {
        sessionRuntime.noteWriteFlushed(sid);
      });
    });
    return () => {
      unsubscribe();
    };
  }, []);

  // ---- bootstrap effect ----
  //
  // Auto-create the first session when the page loads with no sessions in
  // the store. Preserves the T6 UX ("open page → terminal attaches"). The
  // sidebar's + New Session button drives subsequent sessions through the
  // same store API, so this effect only ever fires once per page lifetime.
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

  // ---- runtime attach for every known session ----
  //
  // Whenever the session list grows, make sure the runtime is tracking each
  // sid. Idempotent — runtime.attach() is a no-op for sids it already owns.
  // We never detach here: detach belongs to the explicit "user closed the
  // row" code path (Sidebar already wires that to runtime.detach via the
  // closeSession action — see Sidebar.tsx).
  useEffect(() => {
    const tok = resolveToken();
    if (!tok) return;
    for (const s of sessions) {
      if (!sessionRuntime.has(s.sid)) {
        sessionRuntime.attach(s.sid, tok);
      }
    }
  }, [sessions, token]);

  // ---- xterm lifecycle (re-runs on activeSid change) ----
  //
  // We rebuild xterm on every effect run because StrictMode dev cleanup
  // disposes the previous one. On a real activeSid change we ALSO reset the
  // freshly-built terminal and replay the new sid's scrollback from the
  // runtime, so switching sessions shows their accumulated history instead
  // of an empty screen.
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
    activeSidRef.current = activeSid;

    // ---- Replay scrollback for the new active session ----
    if (!activeSid) {
      writeNoticeTo(term, '[no active session — click + New Session]');
    } else if (!tok) {
      writeNoticeTo(term, '[no token in URL — append ?token=<t> and reload]');
    } else {
      // The runtime should already have an entry from the attach effect
      // above; defensively ensure it (handles the rare race where xterm
      // mounts before the attach effect on the same render commit).
      if (!sessionRuntime.has(activeSid)) {
        sessionRuntime.attach(activeSid, tok);
      }
      const entry = sessionRuntime.get(activeSid);
      if (entry) {
        const decoder = new TextDecoder();
        // Replay chunks in order. xterm internally buffers writes, so even a
        // multi-MB scrollback drains without blocking the event loop.
        for (const chunk of entry.scrollback) {
          term.write(decoder.decode(chunk, { stream: true }));
        }
      }
      // Push the current viewport so the daemon PTY matches the freshly
      // built Terminal (avoids the node-pty default 80x24 sticking around).
      sessionRuntime.sendResize(activeSid, term.cols, term.rows);
    }

    // ---- xterm input/resize wiring ----
    const inputDisp = term.onData((data) => {
      const sid = activeSidRef.current;
      if (sid) sessionRuntime.sendInput(sid, data);
    });
    const resizeDisp = term.onResize(({ cols, rows }) => {
      const sid = activeSidRef.current;
      if (sid) sessionRuntime.sendResize(sid, cols, rows);
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
      // Clear termRef BEFORE disposing so any in-flight runtime callback
      // hits the null branch instead of writing into a half-disposed Terminal.
      if (termRef.current === term) {
        termRef.current = null;
      }
      // Don't null out activeSidRef on cleanup — the runtime listener uses it
      // to gate writes to the live xterm; the next effect run sets it again.
      term.dispose();
      // NOTE: we deliberately DO NOT detach the runtime entry on cleanup.
      // T10's whole point is that scrollback survives sid switches AND
      // StrictMode remounts. detach() is invoked only by the sidebar's
      // closeSession path (after DELETE /api/sessions/:sid succeeds).
    };
  }, [activeSid, token]);

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
