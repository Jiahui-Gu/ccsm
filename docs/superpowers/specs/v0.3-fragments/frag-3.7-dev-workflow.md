# Fragment: §3.7 Dev workflow (hot-reload + auto-reconnect)

**Owner**: worker dispatched per Task #938
**Target spec section**: new §3.7 in main spec (after §3.6)
**P0 items addressed**: #13 (dev hot-reload + auto-reconnect)

## What to write here
Replace this section with the actual `## 3.7 Dev workflow` markdown. Cover:
1. **`npm run dev` topology in v0.3**:
   - Electron main + renderer (existing vite/electron-forge dev).
   - Daemon spawned as separate Node process via nodemon; restarts on
     `daemon/**` source changes.
   - Specify which workspace script orchestrates both (concurrently? turbo?
     existing pattern?).
2. **Electron client auto-reconnect**:
   - On socket EOF / ECONNREFUSED, Connect client retries with exponential
     backoff: 200ms → 400ms → 800ms → ... cap 5s.
   - During reconnect: bridge calls queue (bounded 100? reject after?), UI
     shows "daemon reconnecting…" toast (existing toast system).
   - On reconnect success: replay any session subscription state (sids the
     renderer was watching) so user doesn't lose live view.
3. **Prod behavior** (contrast): supervisor is the OS service / electron
   main; auto-reconnect logic still applies but daemon restart is rarer.

Cite findings from `~/spike-reports/v03-review-devx.md`.

## Plan delta
- New task or extend Task 1 (workspace setup): nodemon config (+2h),
  npm script wiring (+1h).
- New task or extend Task 7 (Connect client): auto-reconnect + queue
  (+4h), tests (+2h).
- Renderer toast wiring (+1h, can fold into existing UI task).
