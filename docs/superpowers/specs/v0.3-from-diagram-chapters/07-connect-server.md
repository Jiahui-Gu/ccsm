# 07 — Connect server

> Authority: [final-architecture §2.8](../2026-05-02-final-architecture.md#2-locked-principles) (data plane = Connect-RPC over HTTP/2 on Listener A and Listener B), §2.3 (transport-keyed trust).

## Stack

- **Runtime:** Node.js (existing daemon runtime; bundled via `@yao-pkg/pkg` or equivalent — see [13-packaging-and-release](./13-packaging-and-release.md)).
- **Server library:** `@connectrpc/connect-node` over Node's built-in `http2` for Listener B and `http2` over UDS / named pipe for Listener A.
- **Codecs:** binary (proto) primary; JSON enabled for dev ergonomics and browser future.
- **Compression:** gzip + brotli enabled by default.

## Mount layout

```
daemon/src/connect/
├── index.ts            (entry: bind both listeners, register interceptors, mount routers)
├── peer-cred.ts        (used by Listener A; see ch.03)
├── jwt.ts              (used by Listener B; see ch.04)
├── routers/
│   ├── session.ts      (implements SessionService — bodies in ch.08 + ch.09)
│   ├── pty.ts          (implements PtyService — bodies in ch.09)
│   ├── db.ts           (implements DbService — bodies in ch.10)
│   ├── control.ts      (implements ControlService)
│   └── presence.ts     (Code.Unimplemented stub)
└── interceptors/
    ├── logging.ts      (structured request logs to ch.11 sink)
    ├── error-map.ts    (maps internal errors → Connect Code)
    └── auth-jwt.ts     (only on Listener B; thin wrapper around jwt.ts)
```

## Bind order (synchronous, fail-fast)

1. Read config + `dataRoot`.
2. Create both `net.Server`s (Listener A UDS/pipe; Listener B `127.0.0.1:0`).
3. Attach peer-cred check to Listener A's `'connection'` event ([ch.03](./03-listener-A-peer-cred.md)).
4. Wrap both `net.Server`s with `http2.createSecureServer` (Listener B) / `http2.createServer` (Listener A — UDS, no TLS).
   - **Listener B uses ALPN h2 over plaintext** (`http2.createServer`, not `createSecureServer`) since the consumer is `cloudflared` on the same loopback. TLS termination is at CF Edge. **Why:** §1 diagram — cloudflared is the only intended Listener B consumer; double-TLS is wasted CPU and a key-management problem.
5. Mount Connect router on Listener A with **all** services and **only** `logging` + `error-map` interceptors (no `auth-jwt`).
6. Mount Connect router on Listener B with **all** services and **all** interceptors including `auth-jwt`.
7. Bind both. Either failing → exit non-zero.
8. After both bound: write `port-tunnel` file ([ch.04](./04-listener-B-jwt.md)), update `ServerInfo`, mark `listener_a_ready` / `listener_b_ready`.

## Interceptor identity (transport-keyed trust)

The `auth-jwt` interceptor is registered on the Listener B Connect router only. There is **no shared interceptor list** between the two routers; the router objects are distinct constructions. **Why:** §2.3 — sharing an interceptor list invites a future contributor to add a header-bypass branch "for testing"; physically separate stacks make this structurally impossible.

## Error model

`interceptors/error-map.ts` maps internal errors:
- `NotFoundError` → `Code.NotFound`
- `ValidationError` → `Code.InvalidArgument`
- `UnauthorizedError` → `Code.Unauthenticated` (only ever emitted on Listener B)
- All other thrown → `Code.Internal` with sanitized message; full stack to log sink only.

## Streaming PTY semantics

`PtyService.Write` is client-streaming; `SessionService.Subscribe` is server-streaming. Both lifetimes are bound to the underlying HTTP/2 stream; client disconnect → server-side cleanup ([ch.09](./09-pty-host.md) fan-out registry deregisters subscriber; PtyService.Write end → no PTY child kill, just stream end). **Why:** clients are subscribers ([§2.7](../2026-05-02-final-architecture.md#2-locked-principles)), not owners.

## §7.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。Connect server 在两个 listener 上 mount 全部 service, 物理隔离的 interceptor stack, error-map / logging interceptor — 这套 scaffold 在 v0.4 加 web/iOS 时**完全沿用**: web 走 cloudflared -> Listener B (同一份 jwt interceptor 处理), iOS 同理。v0.4 不会调整 router 注册顺序、不会合并 interceptor stack (合并 = §2.3 violation)。**Why 不变:** final-architecture §2.3 (transport-keyed trust) + §2.8 (Connect on both listeners)。

## Cross-refs

- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md), [04-listener-B-jwt](./04-listener-B-jwt.md) — auth substrate.
- [06-proto-schema](./06-proto-schema.md) — schema source.
- [08-session-model](./08-session-model.md), [09-pty-host](./09-pty-host.md), [10-sqlite-and-db-rpc](./10-sqlite-and-db-rpc.md) — handler bodies.
- [11-crash-and-observability](./11-crash-and-observability.md) — log + crash sink.
