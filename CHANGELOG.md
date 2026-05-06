# ccsm-web changelog

## v0.1.0 — Phase 3 acceptance + walking-skeleton ready

First tagged release. End-to-end cold-start path works: daemon boots, mints
a token, frontend SPA navigates with `?token=`, the WS upgrade attaches to
a real `claude` PTY, and bidirectional I/O round-trips through the binary
frame protocol with backpressure + lastSeq replay.

### Phase 1 — walking skeleton

- **T0.5 (#660)** PTY + WS happy-path "rig" smoke spec proves `claude`
  spawn → frame round-trip in isolation.
- **T1 (#656)** monorepo skeleton (pnpm workspaces, TS strict, ESLint flat
  config, Vitest, cross-platform CI matrix on ubuntu + windows).
- **T2 (#657)** `@ccsm/shared` binary frame codec (encode/decode + typed
  payload helpers for RESIZE / EXIT) + Vitest coverage.
- **T3 (#658)** daemon HTTP layer — token + Origin allowlist auth, in-memory
  session CRUD stub, static SPA serving with path-traversal guard.
- **T4 (#659)** daemon WS layer — node-pty bridge, frame fan-out, EXIT
  propagation, kill-on-last-subscriber-leaves cleanup.
- **T5 (#nnn)** frontend SPA shell + Sidebar with the six DESIGN.md §7
  testids and "No sessions yet" empty state.
- **T6 (#nnn)** frontend WS client + xterm bridge with reconnect + session
  runtime owning per-sid pendingWrites for backpressure decisions.
- **T7 (#663)** end-to-end `p1-smoke.spec.ts`: cold start → real claude PTY
  → `/help` round-trip → resize → sidebar clicks → bad-token failure mode.
- **T0.5 e2e rig (#664)** worker-scoped daemon fixture + screenshot helper
  that emits PNG + TXT pairs for manager multimodal review.

### Phase 2 — robustness

- **T8 (#661)** ring buffer + lastSeq replay + RESET on cold reconnect; the
  client picks back up where it left off across daemon restarts within
  the ring window.
- **T9 (#nnn)** scrollback locality (active session preserves scroll on
  re-mount; inactive sessions stream into the ring not into xterm).
- **T10 (#662)** multi-session orchestration: groups sidebar, archived
  state, deletion path through the REST API.

### Phase 3 — acceptance

- **T11 (#654)** PAUSE/RESUME backpressure: frontend session-runtime sends
  PAUSE when pendingWrites crosses 16, RESUME when the queue drains; daemon
  honours per-subscriber pause queue with a 1 MiB cap (close 1009 +
  client-side reconnect-with-lastSeq recovery on overflow).
- **T12 (#655)** acceptance gate (this release):
  - Cross-platform CI matrix: e2e job now runs on ubuntu **and** windows
    (excluding `p1-smoke` + `p3-stress`, which need an authed `claude`).
  - 15 explicit negative-path tests in `packages/daemon/test/negative.test.ts`
    covering HTTP missing/wrong/malformed token, bad/missing/unparseable
    Origin, and WS handshake refusals (no token, bad Origin, missing Origin,
    unknown sid, missing sid, garbage lastSeq tolerated).
  - `packages/daemon/test/lifecycle.test.ts`: SIGINT graceful shutdown
    within 4 s (POSIX; skipped on win32 — `process.kill('SIGINT')` is
    `TerminateProcess` there) + 5 s idle window proves no self-exit and no
    stderr noise.
  - `packages/e2e/tests/p3-stress.spec.ts`: real-PTY stress that drives a
    sustained 500 KB+ echo burst and asserts at least one PAUSE frame is
    emitted (T11 wiring exercised end-to-end), the UI stays responsive
    (sidebar clickable, viewport resize still propagates to xterm, input
    still types). Skipped on CI for the `claude` auth reason; manager Reads
    PNG + TXT under `packages/e2e/snapshots/p3-stress/`.
  - macOS is intentionally **not** in the CI matrix for v0.1.0 — see
    README "Platform support". Contributions welcome.

## P1 walking skeleton (Task #663)

First end-to-end run of the cold-start happy path:

- `pnpm e2e` boots the daemon (built artifact), spawns a real `claude` PTY
  via `node-pty`, brings up the Vite dev server, navigates a headless
  Chromium with `?token=<t>`, waits for OUTPUT bytes to render in xterm,
  types `/help` and confirms the body comes back through the same socket.
- Sidebar layout (DESIGN.md §7) renders all six placeholder testids
  (`sidebar-new-session`, `sidebar-search`, `sidebar-groups`,
  `sidebar-archived`, `sidebar-settings`, `sidebar-import`) and the
  "No sessions yet" empty state.
- Resize, sidebar placeholder clicks, and unauthenticated-token paths are
  all covered. Evidence (PNG + TXT pairs) lives under
  `packages/e2e/snapshots/p1-smoke/` and is uploaded as a CI artifact for
  the reviewer / manager to verify.

### Shared package ESM fix

`packages/shared/src/index.ts` now re-exports with explicit `.js`
extensions (`./frame.js`, `./api.js`). Without this Node 22 strict ESM
refuses to resolve the daemon's transitive imports through
`packages/shared/dist/index.js`, blocking the daemon from starting at all.
The shared `tsconfig.json` keeps `module: ESNext` / `moduleResolution:
Bundler` (so the typecheck still passes); the source-level fix is the
narrowest change that unblocks the runtime resolver.
