# 14 — Deletion list

> Authority: [01 anti-patterns](./01-goals-and-non-goals.md#anti-patterns-any-of-these-in-any-chapter--p0-reject), [00 zero-rework guarantee](./00-overview.md#ship-goal-frozen).

This chapter lists files / code paths whose presence in the v0.3 tree contradicts the topology. Any of these surviving the v0.3 PR is a P0 reject from the Stage 2 reviewer.

## Hard deletions (entire files)

The exact paths below are **expected** locations based on v0.2 conventions. Stage 2 reviewer MUST verify against `working` HEAD; if a file moved or was already absent, that is fine — the rule is "no equivalent shall exist", not "this exact path".

| Path | Why deleted |
|---|---|
| `electron/main/pty/*` (any node-pty wrapper in Electron main) | PTY is in daemon ([ch.09](./09-pty-host.md)) |
| `electron/main/sqlite/*` or `electron/main/db/*` | SQLite is in daemon ([ch.10](./10-sqlite-and-db-rpc.md)) |
| `electron/main/session-manager.ts` (or equivalent) | sessions are server-authoritative ([ch.08](./08-session-model.md)) |
| `electron/main/envelope-client.ts` (or any envelope codec in renderer/main) | data plane is Connect; envelope is supervisor-only ([ch.05](./05-supervisor-control-plane.md), [ch.07](./07-connect-server.md)) |
| `daemon/src/envelope/data-plane/*` (any data-plane envelope schemas) | data plane is Connect ([ch.07](./07-connect-server.md)) |
| `daemon/src/supervisor/hello-hmac.ts` (or HMAC helpers used by `daemon.hello`) | HMAC removed ([ch.05](./05-supervisor-control-plane.md)) |
| Shared `crypto/hello-secret.ts` (Electron + daemon) | HMAC removed |
| `**/trace-id-map.ts` (any code mapping envelope correlation IDs to Connect / vice-versa) | no envelope <-> Connect bridge exists in v0.3; data plane and control plane are disjoint |
| Any file containing the literal string `TODO(v0.4)` or `FIXME: v0.4` | rework anti-pattern ([01](./01-goals-and-non-goals.md)) |

## Hard deletions (code paths within retained files)

- `daemon.hello` handler: drop the HMAC-verify branch and the secret-lookup. The new hello validates only `{client_version, capabilities}`.
- Connect interceptor stack on Listener A: MUST NOT contain `auth-jwt` ([ch.07](./07-connect-server.md)); if present, delete.
- Any header-bypass branch in `auth-jwt` interceptor (`if header.X-Local`...): delete.

## Forbidden additions

- New file under `electron/main/` named `*pty*`, `*sqlite*`, `*session*-manager*`, `*envelope*`. CI lint MUST reject.
- Any v0.4-named file (e.g. `cloudflared-supervisor.ts`, `web-bridge.ts`). v0.4 code does not land in the v0.3 tree.

## Verification

Stage 2 reviewer runs:

```bash
# Should be empty
rg -n 'TODO\(v0\.4\)|FIXME: v0\.4|// v0\.4 will'
rg -n 'hello.?hmac|HelloHmac' daemon/ electron/
rg -n "from ['\"]node-pty['\"]" electron/
rg -n "from ['\"]better-sqlite3['\"]" electron/
rg -n '0\.0\.0\.0' daemon/src/connect/
```

All must return zero matches.

## §14.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。本章是删除清单 — 删了就是删了。v0.4 不会"恢复"任何被删的文件 (envelope 数据面、hello-HMAC、renderer SQLite 直连) 因为这些违反 final-architecture §2.3 / §2.7 / §2.8 的拓扑结构, 在 v0.4 同样违反。本清单只会**追加**不会**回滚**。

## Cross-refs

- [01-goals-and-non-goals](./01-goals-and-non-goals.md)
- [05-supervisor-control-plane](./05-supervisor-control-plane.md)
- [07-connect-server](./07-connect-server.md)
- [09-pty-host](./09-pty-host.md), [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md)
- [12-electron-thin-client](./12-electron-thin-client.md)
