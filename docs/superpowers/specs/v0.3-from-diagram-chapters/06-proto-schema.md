# 06 — Proto schema

> Authority: [final-architecture §2.2](../2026-05-02-final-architecture.md#2-locked-principles) (three first-class clients, all consume same `proto/`), §2.8 (data plane = Connect-RPC over HTTP/2, generated from `proto/`, `buf breaking` gates every PR).

## Layout

```
proto/
├── buf.yaml
├── buf.gen.yaml
├── buf.lock
└── ccsm/
    └── v1/
        ├── common.proto         (shared scalar types, error model, pagination)
        ├── control.proto        (data-plane control: list_listeners, server_info)
        ├── session.proto        (session CRUD, snapshot, list, attach)
        ├── pty.proto            (PTY input, output stream, resize, signal)
        ├── db.proto             (DB RPCs: app_state, session_meta — see ch.10)
        └── presence.proto       ("another client typing"; v0.3 stub, full in v0.4)
```

**Why this is v0.4-complete in v0.3:** §2.2 says "adding a fourth client = generating a fourth client; no backend change". For that to hold, the schema MUST already declare the methods v0.4's web/iOS clients need. v0.3 ships **method bodies for everything desktop needs** and **method stubs (returning `Code.Unimplemented`) for everything web/iOS will need**. v0.4 fills in the unimplemented bodies; v0.4 does not edit `.proto` files except additively.

## Required services and notable methods

### `ccsm.v1.SessionService`
- `Create(CreateRequest) returns (Session)` — implemented v0.3.
- `Get(GetRequest) returns (Session)` — implemented v0.3.
- `List(ListRequest) returns (ListResponse)` — implemented v0.3, paginated.
- `Snapshot(SnapshotRequest) returns (SnapshotResponse)` — bounded ring buffer dump (xterm-headless), see [09-pty-host](./09-pty-host.md).
- `Subscribe(SubscribeRequest) returns (stream Delta)` — server-streaming, snapshot+delta-from-`seq`. Implemented v0.3.
- `Close(CloseRequest) returns (Empty)` — implemented v0.3.

### `ccsm.v1.PtyService`
- `Write(stream PtyWriteFrame) returns (Empty)` — client-streaming. Implemented v0.3 with broadcast-all + LWW ([08-session-model](./08-session-model.md)).
- `Resize(ResizeRequest) returns (Empty)` — implemented v0.3.
- `Signal(SignalRequest) returns (Empty)` — implemented v0.3 (SIGINT/SIGTERM to claude CLI subprocess).

### `ccsm.v1.DbService`
- `AppStateGet(KeyRequest) returns (Value)` — implemented v0.3.
- `AppStateSet(KeyValue) returns (Empty)` — implemented v0.3.
- `SessionMetaGet/Set/List` — implemented v0.3.

### `ccsm.v1.ControlService`
- `ServerInfo(Empty) returns (ServerInfo)` — `{version, build_sha, listener_a_ready, listener_b_ready, pid, uptime_s}`. Implemented v0.3.
- `ListListeners(Empty) returns (ListenersResponse)` — implemented v0.3 (returns the two listeners + their ready state; never the supervisor socket).

### `ccsm.v1.PresenceService` (v0.3 stub)
- `Subscribe(Empty) returns (stream PresenceEvent)` — returns immediately with `Code.Unimplemented` in v0.3. Schema present so v0.4 web client can compile against it without proto change. **Why deferred:** §3 ("presence indicators / 'another client is typing' UX").

## buf CI

`buf lint`, `buf format --diff --exit-code`, and `buf breaking --against '.git#branch=main,subdir=proto'` MUST run on every PR that touches `proto/**`. **Why:** §2.8 explicit ("`buf breaking` gates every PR that touches the schema").

`buf.gen.yaml` MUST emit:
- TypeScript via `@bufbuild/protoc-gen-es` and `@connectrpc/protoc-gen-connect-es` for daemon + Electron consumption.
- Swift via `connect-swift` plugin — **generated in v0.3 even with no consumer**, so v0.4 iOS client compiles against current outputs and the plugin is proven on CI day 1. **Why:** zero-rework; if Swift codegen breaks at v0.4, that's a v0.3 schema bug surfaced too late.
- (Web client uses the same TS output — no separate target needed.)

## Server-streaming contract

`SessionService.Subscribe` and `PresenceService.Subscribe` are server-streaming. Connect over HTTP/2 supports server-streaming natively. Browser stream-support matrix is a v0.4 concern ([final-architecture §4](../2026-05-02-final-architecture.md#4-subordinate-specs-placeholders) — v0.4 transport spec); v0.3 desktop uses Node `@connectrpc/connect-node` which has full HTTP/2 server-streaming.

## Forbidden

- Per-client proto packages (e.g. `ccsm.desktop.v1`). **Why:** §2.2 — single schema, all clients.
- Removing or renaming methods from one v0.3 → v0.4 (would be a `buf breaking` failure anyway).
- Embedding envelope-style framing inside Connect messages. **Why:** envelope is supervisor-only.

## §6.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。proto/ schema 在 v0.3 已声明 v0.4 全部 service (含 PresenceService stub), v0.4 只**填充** `Code.Unimplemented` 的方法体 (additive)。`buf breaking` 在 v0.3 day 1 启动, 后续每次 PR 都 gate, 结构上禁止破坏性修改。Swift codegen 在 v0.3 CI 跑, v0.4 iOS 客户端编译时无新工具链需求。**Why 不变:** final-architecture §2.2 ("adding a fourth client = generating a fourth client; no backend change") + §2.8 ("buf breaking gates every PR")。

## Cross-refs

- [07-connect-server](./07-connect-server.md) — wires this schema to Listener A/B.
- [08-session-model](./08-session-model.md), [09-pty-host](./09-pty-host.md) — semantics behind `SessionService` and `PtyService`.
- [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md) — semantics behind `DbService`.
