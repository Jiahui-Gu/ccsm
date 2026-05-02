# 03 — Listener A (peer-cred trusted)

> Authority: [final-architecture §2.3](../2026-05-02-final-architecture.md#2-locked-principles) (two listeners, transport-keyed trust), §2.4 (desktop → Listener A), §2.5 (auth = peer-cred on Listener A).

## Purpose

Listener A is the daemon's **same-UID local socket**. Any process that successfully connects to it is trusted as the user. JWT validation is **bypassed by virtue of the transport itself** (i.e., the bypass is implemented as "Listener A's HTTP server has no auth interceptor", not as "the auth interceptor checks a header and skips"). **Why:** §2.3 ("the JWT bypass is keyed on the listener (transport identity), never on a request header").

## Bind contract

- **macOS / Linux:** Unix Domain Socket at `${runtimeDir}/ccsm/sock` (see [02-process-topology](./02-process-topology.md#filesystem-layout-per-os)). Permissions `0600` (owner-only). Parent dir created with `0700`.
- **Windows:** Named pipe at `\\.\pipe\ccsm-<sid>` where `<sid>` = current user SID. PIPE_ACCESS_DUPLEX, security descriptor allowing only owner SID.
- Bind is **synchronous at daemon startup**; failure to bind = fatal exit code 11 (port-conflict / permission).
- Single-instance check ([02 L5](./02-process-topology.md#lifecycle-rules-v03)) happens against this exact path.

## Peer-cred verification (per OS)

The daemon enforces peer-cred at accept-time, not at request-time, so an attacker who somehow obtains an FD cannot upgrade trust mid-stream.

| OS | Mechanism | Failure handling |
|---|---|---|
| Linux | `getsockopt(SO_PEERCRED)` → `struct ucred`; require `uid == getuid()` | reject + close |
| macOS | `getsockopt(LOCAL_PEERCRED)` → `struct xucred`; require `cr_uid == getuid()` | reject + close |
| Windows | `GetNamedPipeClientProcessId` → `OpenProcessToken` → `GetTokenInformation(TokenUser)`; require SID match `GetCurrentProcessToken` SID | reject + close |

The peer-cred check lives in `daemon/src/connect/peer-cred.ts` and runs as a `net.Server` `'connection'` listener **before** the connection is handed to the HTTP/2 server. **Why:** transport-keyed trust ([principle 3](../2026-05-02-final-architecture.md#2-locked-principles)).

## What is mounted

The Connect-RPC server (see [07-connect-server](./07-connect-server.md)) is mounted on this listener with **all** services exposed (`session.*`, `pty.*`, `db.*`, `control.*`, `presence.*` stub) and **no auth interceptor**.

## Forbidden

- Mounting Listener A on `127.0.0.1:port`. **Why:** TCP loopback has no peer-cred on macOS/Windows in a portable way; UDS / named pipe is the only portable peer-cred substrate. Also TCP on Linux exposes to other namespaces (containers).
- Reusing Listener A's address for any other socket (the path is canonical).
- Adding header-based escape hatches to Listener B that "behave like A" (this is the [§2.3](../2026-05-02-final-architecture.md#2-locked-principles) violation).

## Test matrix (referenced from [15-testing-strategy](./15-testing-strategy.md))

- T-A1: bind succeeds with correct path/perms on each OS.
- T-A2: second daemon process bind fails fast.
- T-A3: same-UID client accepted; cross-UID client rejected (Linux: spawn child with `setuid`; macOS/Windows: skipped or simulated with mocked `getsockopt`).
- T-A4: connect attempt over `127.0.0.1` to the same daemon's TCP listener fails JWT validation (proves trust is transport-keyed, not service-keyed).

## §3.Z Zero-rework self-check

**v0.4 时本章哪些决策/代码会被修改?** 无。Listener A 的 bind 路径、peer-cred 机制 (Linux SO_PEERCRED / macOS LOCAL_PEERCRED / Windows PIPE SID)、accept-time 检查、无 auth interceptor 的 mount 策略, 全部直接源自 final-architecture §2.3 (transport-keyed trust) + §2.4 (desktop -> A)。v0.4 加 web/iOS 时它们走 Listener B (经 cloudflared), 不影响 Listener A 的任何代码。v0.4 desktop 仍走 Listener A, 同一份 peer-cred 代码服役。

## Cross-refs

- [04-listener-B-jwt](./04-listener-B-jwt.md) — sibling listener.
- [07-connect-server](./07-connect-server.md) — what's mounted here.
- [12-electron-thin-client](./12-electron-thin-client.md) — sole consumer in v0.3.
