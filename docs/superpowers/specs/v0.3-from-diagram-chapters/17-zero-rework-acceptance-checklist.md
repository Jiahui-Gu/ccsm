# 17 — Zero-rework acceptance checklist (ship gate)

> This chapter is **the** ship gate for the v0.3 spec set. It walks every component in [final-architecture §1 diagram](../2026-05-02-final-architecture.md#1-the-diagram) and answers two yes/no questions per row. **Any "v0.4 needs to modify v0.3 code" = YES means the spec set is not mergeable; the responsible chapter must be redesigned.**

## Component-by-component

| Diagram component | v0.3 ships it? | v0.4 will modify v0.3 code? | Justification (chapter / §) |
|---|---|---|---|
| GitHub OAuth IdP | NO (external) | NO | Identity is federated by CF Access; daemon never talks to GitHub directly. ([final-architecture §2.5](../2026-05-02-final-architecture.md#2-locked-principles)) |
| Cloudflare Access (per-app AUD, JWT injection) | NO (external) | NO | Daemon validates the injected `Cf-Access-Jwt-Assertion` on Listener B with placeholder-safe defaults already in v0.3 ([ch.04](./04-listener-B-jwt.md)). v0.4 only fills in real AUD / JWKS knobs via config — no code edit. |
| Cloudflare Tunnel (edge) | NO (external) | NO | Edge is opaque to the daemon. |
| `cloudflared` sidecar (local) | **NO but interface ready** | NO | Listener B is bound + advertises `port-tunnel` file in v0.3 ([ch.04](./04-listener-B-jwt.md#bind-contract)). v0.4 adds a sidecar lifecycle module that **reads** the same file and **spawns** cloudflared as a daemon child. No edit to existing v0.3 daemon code. |
| ccsm-daemon (single binary) | YES | NO | Single binary distribution ([ch.13](./13-packaging-and-release.md)) is the same in v0.4. |
| Listener A (UDS / named pipe, peer-cred, JWT bypass) | YES | NO | Bound day 1 ([ch.03](./03-listener-A-peer-cred.md)); same code in v0.4. |
| Listener B (`127.0.0.1:PORT_TUNNEL`, JWT validated) | YES | NO | Bound day 1 with placeholder-safe interceptor ([ch.04](./04-listener-B-jwt.md)); v0.4 only configures, doesn't recode. |
| Connect-RPC over HTTP/2 (data plane) | YES | NO | Mounted on both listeners day 1 ([ch.07](./07-connect-server.md)); proto schema ships v0.4-complete ([ch.06](./06-proto-schema.md)). v0.4 fills in `Code.Unimplemented` stubs (presence) **without** editing existing handler bodies. |
| Supervisor control plane (UDS, v0.3 envelope) | YES | NO | HMAC removed in v0.3 ([ch.05](./05-supervisor-control-plane.md)); the remaining `hello / shutdown / healthz / supervisor.event` surface is unchanged in v0.4. |
| Session manager | YES | NO | Backend-authoritative, fan-out N>=3 day 1 ([ch.08](./08-session-model.md)). v0.4 web/iOS clients are additional subscribers; same fan-out. |
| PTY host (xterm-headless, snapshot+delta) | YES | NO | Inside daemon day 1 ([ch.09](./09-pty-host.md)). v0.4 doesn't touch PTY; it just adds clients. |
| claude CLI subprocess | YES | NO | Spawned by PTY host; same in v0.4. |
| SQLite | YES | NO | Inside daemon day 1, behind `DbService` ([ch.10](./10-sqlite-and-db-rpc.md)). |
| cwd state | YES | NO | Stored as session row field ([ch.10 schema](./10-sqlite-and-db-rpc.md#schema-v03-minimum)). |
| Crash collector | YES | NO | Inside daemon day 1 ([ch.11](./11-crash-and-observability.md)); same in v0.4. |
| Desktop client (Connect over Listener A) | YES | NO | Thin client over Listener A day 1 ([ch.12](./12-electron-thin-client.md)); v0.4 adds Tauri-port question (UX spec) but the **transport** doesn't change. |
| Web client (`@connectrpc/connect-web`) | **NO but interface ready** | NO | Proto schema ships v0.4-complete in v0.3 ([ch.06](./06-proto-schema.md)) including server-streaming methods; v0.4 web client compiles against existing `proto/` outputs. |
| iOS client (`connect-swift`) | **NO but interface ready** | NO | Same as web — Swift codegen runs in v0.3 CI even with no consumer ([ch.06 buf CI](./06-proto-schema.md#buf-ci)) so v0.4 iOS client compiles against existing outputs. |

## Ship gate verdict

**This table is the ship gate. If any row's "v0.4 will modify v0.3 code?" column reads YES, the entire spec set is NOT mergeable.** The responsible chapter must be redesigned to remove the rework, then this checklist re-verified, before Stage 2 reviewer can approve.

Stage 2 reviewer's first action: walk this table line-by-line against the chapter cited in column 4 and confirm the "NO" claim is structurally true (not just asserted).

## Cross-refs

- [00-overview](./00-overview.md) — ship goal frozen.
- [01-goals-and-non-goals](./01-goals-and-non-goals.md) — the anti-patterns that would make rows flip to YES.
- [final-architecture §1 diagram](../2026-05-02-final-architecture.md#1-the-diagram) — source of truth for component list.
