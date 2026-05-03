# ccsm — Final architecture (frozen baseline)

> **Status: FROZEN — 2026-05-02.** Approved by user; supersedes all prior architecture proposals (incl. PR #787 proposal, `2026-05-01-v0.4-web-design.md` as architecture authority, `2026-04-30-web-remote-design.md`).
>
> **Supersedes (deleted from tree, see git history for archival reads):**
> - `docs/superpowers/specs/2026-04-30-web-remote-design.md`
> - `docs/superpowers/specs/2026-05-01-v0.4-web-design.md`
>
> **Constitution doc.** Locked principles + the topology figure, nothing more. Detail-level design (JWT knobs, sidecar update flow, presence, heartbeat tuning, scrollback persistence, etc.) belongs in subordinate v0.4 specs that hang off this baseline.

---

## §0 v0.3 SHIP GOAL (frozen — no intermediate state, zero v0.4 rework)

> Re-landed from closed PR #841 (host file `v0.3-design.md` was purged by #843 as "poisoned, superseded by from-diagram"). Reviewer pre-approval: https://github.com/Jiahui-Gu/ccsm/pull/841#issuecomment-4365659854. Content verbatim from commit `58a92e5`.

**口径**: v0.3 落地的每一行代码, 在 v0.4 加 web/iOS/远程时**一行不删一行不改**。v0.3 = 本文件 (`2026-05-02-final-architecture.md`) 的**真子集**, 不是过渡形态。任何 "v0.4 再切 / v0.4 再扩 / v0.4 替换" 的做法在 v0.3 PR review 阶段直接 REQUEST-CHANGES。

### v0.3 必须做 (做完 v0.4 不返工)

1. **`proto/` schema 一次到位** — 含 v0.4 全部 service (`pty` / `sessions` / `db` / `crash` / `daemon`) + server-streaming 签名。`buf breaking` 上 CI。v0.4 不改 schema, 只多生成 web/swift 客户端。
2. **Connect-RPC over HTTP/2 数据面** — `daemon/src/connect/` Connect-Node server, 所有数据面 RPC 走它。零 envelope 数据面代码。
3. **Listener A** (peer-cred UDS / 命名管道) — desktop 直连。peer-cred 信任绑 transport, 不绑 header。
4. **Listener B** (`127.0.0.1:PORT_TUNNEL`) **物理 bind + JWT interceptor 完整实现** — 即使 v0.3 没人连它, listener 必须存在, JWT 校验代码 + UT 必须写完。v0.4 接 cloudflared = 打开开关, 不是加代码。
5. **Supervisor 控制面保留 envelope** — `/healthz` / `daemon.hello` / `shutdown*` 不动。但 `daemon.hello` 的 hello-HMAC 摘掉 (auth 改走 peer-cred + JWT)。
6. **Daemon 不是 Electron 子进程** — daemon OS-lifecycle 从 day 1 立住, 即使 v0.3 只有 desktop 用, daemon 也必须能脱离 Electron 活。
7. **Session 模型 backend-authoritative + snapshot+delta + broadcast+LWW** — PTY host 一上来就按 N≥3 客户端 fan-out 写, 不是 "先 N=1 后扩"。RAM-only scrollback。
8. **Electron = 纯 thin client** — `@connectrpc/connect-node` 打 Listener A, 零业务逻辑, 零本地状态 (除渲染缓存)。

### v0.3 不做 (但留接口/留位置, 不是留 TODO)

| 不做 | 留什么 |
|---|---|
| cloudflared sidecar 进程管理 | Listener B 已 bind, 等 sidecar 来连 |
| Web 客户端 `web/` | proto schema 已含全部 service |
| iOS 客户端 | 同上 |
| OS supervisor (headless mode) | daemon 已 detach Electron, 加 launchd/service 是外挂 |
| Scrollback 持久化 | session 模型已 authoritative, 加持久化是 PTY host 内部加层 |
| Multi-machine | — |

### 反模式 (PR review REQUEST-CHANGES 触发器)

- ❌ "先用 envelope 做数据面, v0.4 再切 Connect" — 直接上 Connect。
- ❌ "Listener B 先不 bind, v0.4 再加" — 必须 bind, JWT interceptor 必须完整 + UT。
- ❌ "PTY host 先 N=1, v0.4 扩 fan-out" — 一上来就 broadcast+LWW。
- ❌ "Electron 主进程暂留点业务逻辑" — 全下沉 daemon。
- ❌ "hello-HMAC 先留着兼容旧客户端" — 直接删, 旧客户端不存在。
- ❌ 任何 `// TODO v0.4` / `// will be replaced` / `// temporary` 注释。

---

## §1 The diagram

```
                   ┌──────────────────────────┐
                   │  GitHub OAuth IdP        │
                   └────────────┬─────────────┘
                                │ identity (federated by CF Access)
                                ▼
                   ┌──────────────────────────┐
                   │  Cloudflare Edge         │
                   │   - Cloudflare Access    │
                   │     (per-app AUD,        │
                   │      Cf-Access-Jwt-      │
                   │      Assertion injected) │
                   │   - Cloudflare Tunnel    │
                   └────────────┬─────────────┘
                                │ HTTPS / HTTP/2
                                │ (Cf-Access-Jwt-Assertion header)
                                ▼
   ╔════════════════════════════ user's local machine ════════════════════════════╗
   ║                                                                              ║
   ║   ┌───────────────────────────┐                                              ║
   ║   │  cloudflared (sidecar)    │     spawned + lifecycled                     ║
   ║   │  - tunnel client          │◀──── by ccsm-daemon (user-toggled)           ║
   ║   │  - HTTP/2 only            │                                              ║
   ║   └───────────────┬───────────┘                                              ║
   ║                   │  127.0.0.1:PORT_TUNNEL  (Connect-RPC, JWT required)      ║
   ║                   ▼                                                          ║
   ║   ┌──────────────────────────────────────────────────────────────────────┐   ║
   ║   │  ccsm-daemon  (single binary, backend-authoritative)                 │   ║
   ║   │                                                                      │   ║
   ║   │   ┌─────────── data plane ───────────┐  ┌── control plane ──┐        │   ║
   ║   │   │  Listener A: loopback / UDS      │  │  Supervisor UDS   │        │   ║
   ║   │   │    (peer-cred, JWT bypass)       │  │  (v0.3 envelope)  │        │   ║
   ║   │   │  Listener B: 127.0.0.1:PORT_TUN  │  │  /healthz, hello, │        │   ║
   ║   │   │    (CF Access JWT validated;     │  │  shutdown*        │        │   ║
   ║   │   │     cloudflared-only consumer)   │  └───────────────────┘        │   ║
   ║   │   └────────────────┬─────────────────┘                                │   ║
   ║   │                    │                                                  │   ║
   ║   │       Connect-RPC over HTTP/2 (proto-generated surface)               │   ║
   ║   │                                                                      │   ║
   ║   │   Session manager · PTY host (xterm-headless, snapshot+delta) ·      │   ║
   ║   │   claude CLI subprocess · SQLite · cwd state · crash collector       │   ║
   ║   └──────────────────────────┬───────────────────────────────────────────┘   ║
   ║                              │                                               ║
   ║                              │ Listener A                                    ║
   ║                              ▼                                               ║
   ║   ┌──────────────────────────────────────┐                                   ║
   ║   │  Desktop client (same machine)       │                                   ║
   ║   │  - Connect client (proto-generated)  │                                   ║
   ║   │  - hits Listener A directly          │                                   ║
   ║   └──────────────────────────────────────┘                                   ║
   ║                                                                              ║
   ╚══════════════════════════════════════════════════════════════════════════════╝

                   ▲                                              ▲
                   │ (back through CF Edge)                       │
                   │                                              │
   ┌───────────────┴───────────────┐         ┌────────────────────┴──────────────┐
   │  Web client (browser, any net)│         │  iOS client (any network)         │
   │  - @connectrpc/connect-web    │         │  - connect-swift over URLSession  │
   │  - same proto-generated code  │         │  - same proto-generated code      │
   └───────────────────────────────┘         └───────────────────────────────────┘
```

---

## §2 Locked principles

1. **Backend = single binary, runs on the user's local machine ONLY.** No remote deploy target. No SaaS. No multi-tenant. The user's machine is the source of truth for sessions, PTY, claude CLI, SQLite, cwd, crash logs.

2. **Three first-class clients: desktop, web, iOS.** None is "primary". All three consume the same `proto/` schema and the same Connect-RPC surface. Adding a fourth client = generating a fourth client; no backend change.

3. **Backend exposes TWO loopback listeners.**
   - **Listener A** = peer-cred-trusted local socket (UDS / named pipe). JWT bypass. Same-UID processes only.
   - **Listener B** = `127.0.0.1:PORT_TUNNEL`. Cloudflare Access JWT validated unconditionally. Sole intended consumer is the local `cloudflared` sidecar.
   - Listeners are physically separate. The JWT bypass is keyed on the listener (transport identity), never on a request header.

4. **Client → listener mapping is fixed.**
   - **Desktop on the same machine** → Listener A.
   - **Web + iOS** (and desktop on a different machine) → Cloudflare Edge → `cloudflared` sidecar (local) → Listener B.
   - There is no third path.

5. **Auth = GitHub OAuth, identity provided by Cloudflare Access.** Backend never issues its own tokens. Backend never stores a user database. Backend's auth job on Listener B is "verify the `Cf-Access-Jwt-Assertion` and trust it". Backend's auth job on Listener A is "trust the peer-cred".

6. **`cloudflared` is a local sidecar, lifecycled by the daemon.** User-toggled (off by default). When on, daemon spawns `cloudflared`, points it at Listener B, advertises the public URL. When off, daemon kills the sidecar; web + iOS lose reachability; desktop on Listener A is unaffected.

7. **Session model: backend-authoritative; clients are pure subscribers.**
   - **Catch-up:** snapshot (bounded `xterm-headless` ring buffer) + delta-from-`seq` replay.
   - **Multi-client writes:** broadcast-all + last-writer-wins at the PTY layer. The PTY is the serialization point. No locks. No "primary" client.
   - **Scrollback:** RAM-only (existing v0.3 ring buffer). Long-tail history persistence is a separate, later feature.

8. **Wire surface split between supervisor control plane and data plane.**
   - **Supervisor control plane** (`/healthz`, `daemon.hello`, `daemon.shutdown*`, lifecycle): stays on the local UDS with the v0.3 hand-rolled envelope. Unchanged.
   - **Data plane** (every session / PTY / SQLite-backed RPC): moves to Connect-RPC over HTTP/2 on Listener A and Listener B. Generated from `proto/`. `buf breaking` gates every PR that touches the schema.

9. **Daemon owns its lifecycle.** The daemon is not a child of any client. Closing the desktop client does not stop the daemon. The daemon process model on each OS (launchd / Windows Service / systemd-user) is what respawns it; the in-process supervisor degrades to a crash-loop counter + `.bak` rollback, not "the thing that keeps the daemon alive". `cloudflared` is the daemon's child and dies when the daemon dies.

10. **Single user, single identity.** "Multi-tenant" is out of scope. The user's GitHub identity is the only identity the system knows. Every authenticated request — Listener A peer-cred or Listener B JWT — resolves to the same one user.

---

## §3 What this doc does NOT decide

This baseline locks the topology and the principles, not the parameters. The following all defer to subordinate v0.4 specs that take this doc as authority: exact JWT validation knobs (algorithms, AUD, clock tolerance, JWKS pre-warm + cooldown, bind-gate); `cloudflared` install / supply-chain / update flow; multi-machine semantics if the user later runs the backend on more than one host; presence indicators / "another client is typing" UX; OS-level supervisor for headless mode (launchd / Windows Service / systemd-user) and the daemon-detach-from-Electron lifecycle; heartbeat tuning and idle eviction; PTY scrollback persistence to SQLite; per-listener port discovery contract; CI lint that pins Listener B to `127.0.0.1`. None of these are open questions about the architecture; they are sub-spec decisions inside it.

---

## §4 Subordinate specs (placeholders)

- **v0.4 transport spec** — `proto/` layout, Connect-RPC server mount on Listener A and B, PTY server-stream contract, `buf` CI, browser stream-support matrix. TBD.
- **v0.4 ops / cloudflared spec** — sidecar lifecycle, OS-level supervisor for headless mode, port discovery contract, JWKS bind-gate, multi-machine collision handling. TBD.
- **v0.4 security / auth spec** — JWT validation knobs, peer-cred implementation per platform, bypass-tag-by-transport rule, threat model (residual same-UID risk). TBD.
- **v0.4 client UX spec** — desktop tech choice (Tauri vs Electron-port), web SPA shape, iOS distribution, multi-client write UX (presence vs lock vs naked LWW). TBD.
- **v0.3 reconciliation** — see Task #88 output for how the v0.3 supervisor / PTY / packaging fragments map onto this baseline (supervisor stays as v0.3 envelope; PTY snapshot+delta + fan-out registry generalize from N=1 to N≥3; envelope hardening retires from data plane).
