# 04 — Listener B (JWT validated)

> Authority: [final-architecture §2.3](../2026-05-02-final-architecture.md#2-locked-principles) (two listeners, transport-keyed trust), §2.5 (auth = CF Access JWT on Listener B), §1 diagram (Listener B = `127.0.0.1:PORT_TUNNEL`, "cloudflared-only consumer"), §3 (JWT validation knobs deferred to v0.4 sub-spec).

## Purpose in v0.3

Listener B exists in v0.3 with **zero intended consumer** (the cloudflared sidecar is deferred — see [01 NG1](./01-goals-and-non-goals.md#non-goals-must-not-ship-in-v03)). It is bound from day 1 anyway because the entire transport-keyed-trust story is meaningless if Listener B is "added later"; "added later" inevitably becomes "let me just add a bypass header to Listener A so I don't have to bind a new socket". **Why:** §2.3.

## Bind contract

- **Address:** `127.0.0.1:<PORT_TUNNEL>` where `<PORT_TUNNEL>` is OS-assigned (bind to `:0`, read back). MUST NOT bind to `0.0.0.0` or `::`. A CI lint MUST reject any literal `0.0.0.0` or non-loopback bind in `daemon/src/connect/`. **Why:** §3 ("CI lint that pins Listener B to `127.0.0.1`").
- **Discovery contract:** after bind, daemon writes `${dataRoot}/runtime/port-tunnel` containing the single line `<PORT_TUNNEL>\n` with mode `0600`. The file is unlinked on clean shutdown. **Why:** the v0.4 cloudflared sidecar will read this file to know where to point its tunnel; making the contract concrete in v0.3 lets v0.4 add the sidecar with **zero daemon change**.
- **Bind failure** is fatal (exit code 12). The daemon does not start with one listener bound and the other not — that would silently violate the topology.

## JWT validation

A Connect interceptor on Listener B's HTTP server (and **only** Listener B's; see [03-listener-A-peer-cred](./03-listener-A-peer-cred.md) for why Listener A has no interceptor) MUST:

1. Extract `Cf-Access-Jwt-Assertion` request header. Reject with `Code.Unauthenticated` if absent.
2. Verify signature against a JWKS pre-warmed at daemon start from the configured CF Access team domain.
3. Verify standard claims: `iss` matches team domain, `aud` matches the configured per-app AUD, `exp` not in past (with the configured clock-skew tolerance), `iat` not in distant future.
4. Resolve principal to the single configured GitHub identity (§2.10 — single user, single identity). Mismatch → `Code.PermissionDenied`.

Exact knob values (algorithm allowlist, AUD value, clock tolerance window, JWKS refresh cadence and cooldown, JWKS bind-gate behavior) are **deferred to the v0.4 security sub-spec** ([final-architecture §3](../2026-05-02-final-architecture.md#3-what-this-doc-does-not-decide)). v0.3 ships **the interceptor with placeholder-safe defaults** and an explicit configuration surface (env vars / config file fields) so the v0.4 spec can pin values without changing code. **Why deferred:** §3 explicitly lists "exact JWT validation knobs" as a v0.4 sub-spec item.

### Placeholder-safe defaults (v0.3)

When CF Access env is **unconfigured** (the default, since v0.3 ships no sidecar):

- The interceptor is still installed.
- Every request is rejected with `Code.Unauthenticated` and a structured log `{event:"listenerB.unconfigured", port:<PORT_TUNNEL>}`.
- This proves Listener B is a **closed door** in v0.3, not a side channel.

When CF Access env is **configured** (dev/preview only, off by default):

- JWKS pre-warm runs at startup; failure → daemon refuses to mark Listener B "ready" but daemon overall still starts (Listener A is independent).
- Validation runs as above.

## UT matrix (referenced from [15-testing-strategy](./15-testing-strategy.md))

| ID | Scenario | Expected |
|---|---|---|
| T-B1 | bind on `127.0.0.1:0`, read port, write `port-tunnel` file mode 0600 | port file exists with single line |
| T-B2 | clean shutdown unlinks `port-tunnel` file | file gone |
| T-B3 | bind on `0.0.0.0:0` — **lint-rejected at PR time, not runtime** | CI fail |
| T-B4 | request without JWT header → 401 | reject |
| T-B5 | request with malformed JWT → 401 | reject |
| T-B6 | request with valid JWT but wrong AUD → 403 | reject |
| T-B7 | request with valid JWT and matching identity → request proceeds to handler | accept |
| T-B8 | unconfigured CF Access + any request → 401 with `listenerB.unconfigured` log | reject + log |
| T-B9 | JWKS unreachable at bind time → daemon starts, Listener B marked not-ready, all requests 503 until JWKS refreshes | degraded ready |
| T-B10 | Connect-streaming RPC (PTY) with JWT validated only at handshake (not per-frame) | accept; verify no per-frame revalidation |

## Forbidden

- Header-keyed bypass: `if (req.headers['x-local-trust']) skipAuth()`. **Why:** §2.3 violation.
- Mounting Listener B on the same `net.Server` as Listener A (must be separate listeners with separate interceptor stacks). **Why:** transport-keyed trust requires physically separate interceptor stacks; sharing a server invites code paths to leak trust.
- Issuing tokens (e.g. minting an app-level session token after JWT validation). **Why:** §2.5 ("backend never issues its own tokens").

## §4.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。Listener B 的 bind (`127.0.0.1:0` -> `port-tunnel` 文件)、interceptor 安装 (auth-jwt only on B)、placeholder-safe defaults (unconfigured -> 401 + log) 都是 v0.4 直接复用的接口。v0.4 sidecar 接入只做两件事: (a) 读 `port-tunnel` 文件并启动 cloudflared 指向该端口; (b) 在 daemon 配置里填入真实 CF Access AUD / team domain / JWKS URL — 这是配置变更, 不是代码变更。v0.3 的 interceptor 代码逐字保留。**Why 不变:** final-architecture §2.3 (transport-keyed trust) + §3 (JWT 知识仅 knob 差异)。

## Cross-refs

- [03-listener-A-peer-cred](./03-listener-A-peer-cred.md) — sibling.
- [07-connect-server](./07-connect-server.md) — interceptor mount points.
- [13-packaging-and-release](./13-packaging-and-release.md) — `port-tunnel` file lifecycle in installer/uninstaller.
