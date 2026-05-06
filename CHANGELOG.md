# ccsm-web changelog

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
