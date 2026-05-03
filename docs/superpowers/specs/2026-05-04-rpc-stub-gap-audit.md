# RPC Stub Gap Audit (Task #228, phase 1, research-only)

**Branch**: `research/228-rpc-stub-audit` (off `working` @ 28163e9)
**Date**: 2026-05-04
**Scope**: All Connect-RPC services declared in `packages/proto/src/ccsm/v1/*.proto`. Verifies which RPCs have real production handlers, which return Connect `Unimplemented` (stub), and which are not even registered against the daemon's HTTP/2 surface.
**Out-of-scope**: implementation work, TaskCreate, PR. Manager will TaskCreate based on the "Proposed sub-tasks" section below.

## Method

1. Enumerated services + RPCs from each `.proto` (`packages/proto/src/ccsm/v1/`).
2. Confirmed every service is re-exported from `@ccsm/proto` via `packages/proto/src/index.ts` (wildcard re-exports of `gen/ts/ccsm/v1/*_pb.ts` — the same descriptor module is the *client stub* and the *server descriptor* under Connect-ES v2; there is no separate `*_connect.ts` file).
3. Located handler factories in `packages/daemon/src/` (`grep "ServiceImpl<typeof"`).
4. Read `packages/daemon/src/rpc/router.ts` for stub + real registration topology.
5. Read `packages/daemon/src/index.ts` (lines 280-340) for the production wiring of `makeRouterBindHook(...)` to determine which "real handler" overlays are actually installed at boot.

## Production wiring summary (the load-bearing fact)

`packages/daemon/src/index.ts:308`:

```ts
listenerA = makeListenerA(env, {
  bindHook: makeRouterBindHook({
    helloDeps,                // ONLY helloDeps is supplied
    interceptors: [bearerToPeerInfoInterceptor, peerCredAuthInterceptor],
  }),
});
```

`makeRouterBindHook` -> `createDaemonNodeAdapter({ helloDeps, ... })` -> `router.ts:270`:

```ts
const routes = helloDeps !== undefined ? makeDaemonRoutes(helloDeps, watchSessionsDeps) : stubRoutes;
```

Because production passes `helloDeps` only (no `watchSessionsDeps`), `makeDaemonRoutes` takes the `else` branch (`router.ts:196`) and calls `registerHelloHandler` — which registers ONLY `{ hello }` on `SessionService`. **WatchSessions is NOT wired in production**, even though `makeWatchSessionsHandler` exists in source (`packages/daemon/src/sessions/watch-sessions.ts:431`). The router's "stub baseline" replaces it with `Unimplemented`.

Net effect at boot: of all 27 RPCs across 7 services, exactly ONE (`SessionService.Hello`) has a real handler on the wire. Everything else returns Connect `Unimplemented`.

`SupervisorService` is registered against the Connect router as a stub (per `STUB_SERVICES` in `router.ts:80`) but its real implementation lives on a SEPARATE plain-HTTP UDS server (`packages/daemon/src/supervisor/server.ts`); it is NOT served via Connect framing on Listener A. That dual surface is intentional per spec ch03 §7 and is reflected in the table below.

## Gap table

Legend:
- **SHIPPED** = real handler factory exists in source AND is installed in production wiring AND backs all listed RPCs.
- **STUB** = service is registered with `{}` (or partial impl that omits this RPC); responds Connect `Unimplemented`.
- **NOT_REGISTERED** = service exists in proto but is not added to the router (none today — every service is in `STUB_SERVICES`).
- **HTTP_BYPASS** = service is registered as Connect stub but real impl runs on a separate non-Connect transport.

| service | proto file | client stub generated | server handler exists | registered in router | shipped behavior vs stub | task ID(s) tracking |
|---|---|---|---|---|---|---|
| `SessionService.Hello` | `session.proto:401` | yes (`session_pb.ts` re-exported via `@ccsm/proto`) | yes — `packages/daemon/src/rpc/hello.ts:282` `makeHelloHandler` | yes — `router.ts:142` `registerHelloHandler` (called by `makeDaemonRoutes` else-branch from production index.ts) | **SHIPPED** | T2.3 (#33) |
| `SessionService.WatchSessions` | `session.proto:417` | yes | yes — `packages/daemon/src/sessions/watch-sessions.ts:431` `makeWatchSessionsHandler` | NO in production — `index.ts:308` does not pass `watchSessionsDeps`, so the if-branch of `makeDaemonRoutes` (`router.ts:194`) is never taken; tests use `registerSessionService` directly | **STUB** (handler exists but unwired) | T3.3 (#34) — implementation landed; production-wiring gap |
| `SessionService.ListSessions` | `session.proto:402` | yes | no | stub via `registerStubServices` (`router.ts:98`) | **STUB** | T3.x (none open — gap) |
| `SessionService.GetSession` | `session.proto:403` | yes | no | stub | **STUB** | T3.x (none open — gap) |
| `SessionService.CreateSession` | `session.proto:404` | yes | no | stub | **STUB** | T3.x (none open — gap; #270 installPipeline touches the spawn path but is not the RPC) |
| `SessionService.DestroySession` | `session.proto:405` | yes | no | stub | **STUB** | T3.x (none open — gap) |
| `SessionService.RenameSession` | `session.proto:425` | yes | no | stub | **STUB** | none |
| `SessionService.GetSessionTitle` | `session.proto:426` | yes | no (`packages/daemon/src/sessionTitles/` has support modules but no Connect handler) | stub | **STUB** | none |
| `SessionService.ListProjectSessions` | `session.proto:427` | yes | no | stub | **STUB** | none |
| `SessionService.ListImportableSessions` | `session.proto:428` | yes | no (`packages/daemon/src/importScanner/` exists but is not a handler) | stub | **STUB** | none |
| `SessionService.ImportSession` | `session.proto:429` | yes | no | stub | **STUB** | none |
| `PtyService.Attach` | `pty.proto:282` | yes | no (`packages/daemon/src/pty-host/` runs the PTYs but no Connect handler bridges them) | stub | **STUB** | T4.x family (none open in this audit's snapshot) |
| `PtyService.SendInput` | `pty.proto:283` | yes | no | stub | **STUB** | T4.x |
| `PtyService.Resize` | `pty.proto:284` | yes | no | stub | **STUB** | T4.x |
| `PtyService.AckPty` | `pty.proto:293` | yes | no | stub | **STUB** | T4.x |
| `PtyService.CheckClaudeAvailable` | `pty.proto:300` | yes | no | stub | **STUB** | none |
| `CrashService.GetCrashLog` | `crash.proto:11` | yes | no (`packages/daemon/src/crash/` has pruner + raw-appender + sources but no Connect handler) | stub | **STUB** | #229 (CrashService compaction task — pending) |
| `CrashService.WatchCrashLog` | `crash.proto:12` | yes | no | stub | **STUB** | #229 |
| `CrashService.GetRawCrashLog` | `crash.proto:13` | yes | no | stub | **STUB** | #229 |
| `SettingsService.GetSettings` | `settings.proto:613` | yes | no | stub | **STUB** | none |
| `SettingsService.UpdateSettings` | `settings.proto:623` | yes | no | stub | **STUB** | none |
| `NotifyService.WatchNotifyEvents` | `notify.proto:211` | yes | no (`packages/daemon/src/notify/notifyDecider.ts` is a pure decider, never wired to a Connect stream) | stub | **STUB** | none |
| `NotifyService.MarkUserInput` | `notify.proto:216` | yes | no | stub | **STUB** | none |
| `NotifyService.SetActiveSid` | `notify.proto:217` | yes | no | stub | **STUB** | none |
| `NotifyService.SetFocused` | `notify.proto:218` | yes | no | stub | **STUB** | none |
| `DraftService.GetDraft` | `draft.proto:165` | yes | no | stub | **STUB** | none |
| `DraftService.UpdateDraft` | `draft.proto:166` | yes | no | stub | **STUB** | none |
| `SupervisorService.HealthCheck` | `supervisor.proto:752` | yes (typed mirror only — never used as a Connect client) | no Connect handler; real impl in `packages/daemon/src/supervisor/server.ts` (plain HTTP `/healthz`) | stub on Connect router; real impl on UDS HTTP | **HTTP_BYPASS** (intentional per spec ch03 §7) | n/a (shipped via separate transport) |
| `SupervisorService.SupervisorHello` | `supervisor.proto:753` | yes (mirror) | no Connect handler; real impl on `/hello` UDS HTTP | **HTTP_BYPASS** | n/a |
| `SupervisorService.Shutdown` | `supervisor.proto:754` | yes (mirror) | no Connect handler; real impl on `/shutdown` UDS HTTP | **HTTP_BYPASS** | n/a |

### Counts

- Services audited: **7** (SessionService, PtyService, CrashService, SettingsService, NotifyService, DraftService, SupervisorService).
- Total RPCs: **30** (11 + 5 + 3 + 2 + 4 + 2 + 3).
- **SHIPPED**: **1** RPC (`SessionService.Hello`).
- **STUB**: **26** RPCs (everything else on Listener A, including the 1 RPC whose handler exists but is unwired).
- **NOT_REGISTERED**: **0** (every proto service is in `STUB_SERVICES`).
- **HTTP_BYPASS**: **3** RPCs (SupervisorService — by design, not a gap).

This matches Research D (#205): "26/50 NOT SHIPPED" was a different denominator (counted some types/integration steps); the canonical count for "RPCs returning Unimplemented on Listener A" is **26 / 27** = 96%.

### Notable special cases

1. **`SessionService.WatchSessions` is the highest-leverage low-cost gap.** The handler factory (`makeWatchSessionsHandler`), its deps type (`WatchSessionsDeps`), the `SessionManager` event bus (`packages/daemon/src/sessions/event-bus.ts`), and the combined `registerSessionService` overlay all already exist and are exercised by tests. The only production change required is constructing a `WatchSessionsDeps` in `index.ts` and passing it through `makeRouterBindHook({ helloDeps, watchSessionsDeps })`. This is a one-PR fix with no proto/handler/router work.
2. **`SessionService.CreateSession`, `DestroySession`, `ListSessions`, `GetSession` form a tight DAG.** They share `SessionManager`'s mutator surface (already implemented for the in-memory bus); each is a single Connect handler that adapts manager methods. They should be lifted as four sibling tasks under one epic, NOT one fat task — see "Proposed sub-tasks" below.
3. **`PtyService.Attach` is the largest gap by behavior surface.** `pty-host/host.ts` already drives child PTYs and produces the snapshot/delta stream described in spec ch06; the handler is the missing adapter to a Connect server-stream that consumes the host's per-session emitter and applies `since_seq` resume + `requires_ack` flow control. This is not single-concern and likely needs its own design pass before TaskCreate (do NOT bundle into a generic "PtyService stub gap" task).
4. **`SettingsService` and `DraftService` both depend on a daemon SQLite settings table.** `packages/daemon/src/sqlite/` exists; a quick grep shows it has no `settings`/`draft` tables yet. These two services should not be dispatched until the storage migration lands (forward-safe research task to scope that migration).
5. **`NotifyService.WatchNotifyEvents` mirrors `WatchSessions` topologically** (server-stream from a daemon-internal decider) but its decider (`notifyDecider.ts`) has no event bus around it yet. Closer to a `WatchSessions`-shaped two-PR task: (a) wrap decider in event bus; (b) Connect handler.
6. **`SupervisorService` is intentionally HTTP_BYPASS.** No action required. The router stub registration is per `router.ts` lines 21-30: keeps a uniform "every service is in the router" invariant so misconfigured Connect calls return Unimplemented rather than 404. Listing it in any "gap" task would be wrong.

## Proposed sub-tasks

Each is forward-safe and single-concern. **NOT created** — manager will TaskCreate based on this list.

1. **wire WatchSessions in production daemon startup** — pass `watchSessionsDeps` to `makeRouterBindHook` in `index.ts:308`; construct deps from the existing `SessionManager` instance the daemon already builds. One file changed in production code (`index.ts`), plus an integration spec asserting `WatchSessions` returns events instead of Unimplemented from a real `createDaemonNodeAdapter` call. Wave-locked to current `index.ts` (touches the production wiring block).
2. **CrashService.GetCrashLog Connect handler** (also tracked at #229) — wrap existing `crash/sources.ts` reader behind `ServiceImpl<typeof CrashService>['getCrashLog']`; add `registerCrashService(router, deps)` overlay; thread `crashDeps` through `createDaemonNodeAdapter`. Forward-safe: new file under `packages/daemon/src/rpc/crash/` plus additive overlay.
3. **CrashService.GetRawCrashLog server-streaming handler** — separate PR from #229's unary; needs 64 KiB chunk pump from `state/crash-raw.ndjson`. Forward-safe new file.
4. **CrashService.WatchCrashLog server-streaming handler** — depends on a new `crashEventBus` (does not exist yet); split into (a) bus, (b) handler. Two tasks; (a) is forward-safe (new `crash/event-bus.ts`), (b) is wave-locked to (a).
5. **SessionService.ListSessions + GetSession unary handlers** — single PR (read-only, share `SessionManager.list()` / `get()`). Forward-safe new file `packages/daemon/src/sessions/read-handlers.ts`.
6. **SessionService.CreateSession Connect handler** — depends on PtyService.Attach being scoped (CreateSession returns a session that is then attached). Single PR with a `SessionManager.create()` adapter; mark wave-locked behind the PtyService.Attach design task because the response shape pins the PTY semantics.
7. **SessionService.DestroySession Connect handler** — symmetric with CreateSession; same wave constraint.
8. **NotifyService event-bus support module** (forward-safe research+impl) — wrap `notifyDecider` in an event bus mirroring `sessions/event-bus.ts` so a future `WatchNotifyEvents` handler has a stream source. New `packages/daemon/src/notify/event-bus.ts`; pure additive.
9. **SettingsService storage migration design** — research-only spec task to scope the SQLite `settings` table additions (and reuse for `draft`). Forward-safe new spec doc; unblocks Settings + Draft handler tasks.
10. **PtyService.Attach handler design** — research/spec task only (NOT implementation). Cover: snapshot/delta emitter contract from `pty-host/host.ts`, `since_seq` resume window math, `requires_ack` backpressure (4096-frame backlog ceiling per `pty.proto:320`), HandlerContext.signal cleanup. Output: design doc under `docs/superpowers/specs/`. Implementation tasks lifted in a follow-up wave.

## Files referenced (absolute paths)

- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\common.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\crash.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\draft.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\notify.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\pty.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\session.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\settings.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\ccsm\v1\supervisor.proto`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\proto\src\index.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\index.ts` (lines 280-340 — production wiring)
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\rpc\router.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\rpc\bind.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\rpc\hello.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\sessions\watch-sessions.ts`
- `C:\Users\jiahuigu\ccsm-worktrees\pool-7\packages\daemon\src\supervisor\server.ts`
