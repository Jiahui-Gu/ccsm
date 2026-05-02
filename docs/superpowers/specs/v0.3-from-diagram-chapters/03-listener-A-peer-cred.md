# 03 — Listener A: peer-cred local socket

## Purpose

Listener A is the **trusted same-machine, same-UID** transport for the desktop client. It is the only listener Electron speaks. Its trust is the OS-enforced peer credentials of the connecting process — there is **no token, no header, no challenge**.

**Why:** final-architecture §2 principle 3 — "Listener A = peer-cred-trusted local socket. Same-UID processes only." Trust is bound to **transport identity**, not to a request header (principle 3 + 4).

## Transport choice per OS

| OS         | Transport       | Path / namespace                                                | Permissions / DACL                                            |
| ---------- | --------------- | --------------------------------------------------------------- | ------------------------------------------------------------- |
| macOS      | UNIX domain socket | `<runtimeRoot>/ccsm-data.sock`                               | mode `0600`, owner = current UID                              |
| Linux      | UNIX domain socket | `<runtimeRoot>/ccsm-data.sock`                               | mode `0600`, owner = current UID                              |
| Windows    | Named pipe      | `\\.\pipe\ccsm-data-<cwdHash>-<uidHash>`                        | DACL: owner-only (existing `pipeAcl.applyOwnerOnly` survives) |

`<runtimeRoot>` policy is the existing v0.3 socket-cwd-isolation rule (task #68 KEEP from reconciliation): per-checkout hash component to prevent collisions between worktrees. Concretely:

- macOS / Linux: `${XDG_RUNTIME_DIR or ~/.ccsm/run}/<cwdHash>/`
- Windows: `<cwdHash>` baked into pipe name as shown above.

`<cwdHash>` derivation: `sha256(canonicalRepoRoot).slice(0, 8)` lowercase hex. On a packaged install (no repo), use `sha256(installPath).slice(0,8)`.

**Why named pipe on Windows (not TCP loopback for "Listener A"):** TCP loopback is not peer-cred-checkable on Windows in the same way; named pipes carry the client process token, which is what `GetNamedPipeClientProcessId` + `OpenProcessToken` consume. A loopback TCP socket would let any same-host process connect — that violates principle 3.

## Peer-credential check

Implemented per OS, called on every accepted connection **before** Connect-RPC handlers run (i.e. the Connect-Node server's `connection`-level interceptor or pre-mount accept callback).

### macOS / Linux (UDS)

- Use `getsockopt(SO_PEERCRED)` on Linux; `LOCAL_PEERCRED` (`xucred`) on macOS.
- Reject if connecting UID ≠ daemon UID. Connection is closed before HTTP/2 preface.
- Implemented in `daemon/src/connect/peercred/posix.ts`; backed by `ccsm_native` binding (see [09](./09-pty-host.md) §`ccsm_native` — same native module). Pure-JS fallback is **not** acceptable: there is no portable libuv API for SO_PEERCRED.

### Windows (named pipe)

- On accept, `GetNamedPipeClientProcessId` → PID; `OpenProcess` + `OpenProcessToken` + `GetTokenInformation(TokenUser)` → SID.
- Compare SID with current process's SID. Reject mismatch.
- Implemented in `daemon/src/connect/peercred/win32.ts`, also via `ccsm_native`.

### Test matrix (UT)

- POSIX: same-UID accept passes, different-UID accept rejects. Use `seteuid` only in CI (skip locally).
- Windows: spawn a helper process under a different SID via `CreateProcessAsUser`-style (or skip if env doesn't support) and assert reject.
- Failure path: native binding missing → daemon refuses to bind Listener A and exits with a clear error (no fallback).

**Why fail-closed:** if the native binding cannot establish peer-cred, the listener has no trust story; binding it anyway is worse than failing the daemon.

## Address discovery (the discovery file)

Daemon writes a single JSON discovery file after both listeners are bound:

- Location:
  - macOS / Linux: `<runtimeRoot>/discovery.json`
  - Windows: `%LOCALAPPDATA%\ccsm\run\<cwdHash>\discovery.json`
- Contents (JSON):
  ```json
  {
    "schemaVersion": 1,
    "pid": 12345,
    "listenerA": { "transport": "uds", "path": "/run/.../ccsm-data.sock" },
    "listenerB": { "transport": "tcp", "host": "127.0.0.1", "port": 53421 },
    "supervisor": { "transport": "uds", "path": "/run/.../ccsm-control.sock" },
    "boundAt": "2026-05-02T12:00:00Z",
    "bootNonce": "01HXZ..."
  }
  ```
- File mode `0600` (POSIX) / owner-only ACL (Windows).
- Daemon writes atomically (`write` + `rename`) and `unlink`s on graceful shutdown.

Electron reads this file to discover Listener A. Future `cloudflared` (v0.4) reads it to find Listener B's port. v0.3 has no other consumer of this file.

**Why a discovery file rather than env-var or fixed port:** env vars require parent-spawn coordination (which breaks G4 — daemon may not be Electron's child). Fixed port collides between worktrees. A file at a known location is the simplest contract that works for "daemon found by anyone same-UID on this machine".

## Connect-RPC mount on Listener A

- Server: `@connectrpc/connect-node` HTTP/2 listening on the UDS / named pipe handle.
- Interceptor chain on Listener A (in order):
  1. **Peer-cred** (transport-level, runs on accept; reject before HTTP/2 preface).
  2. **Deadline / timeout** (cap RPC duration; reuse v0.3 deadline logic).
  3. **Logging / trace-id** (per-RPC structured log; trace-id is generated server-side, NOT client-supplied — kills the legacy trace-id-map dependency, see [14](./14-deletion-list.md)).
- **No JWT interceptor** on Listener A. JWT bypass is enforced by mount: the JWT interceptor is registered on Listener B's server only (see [04](./04-listener-B-jwt.md) and [07](./07-connect-server.md)).

## Why peer-cred on Listener A is sufficient

- Same-UID = same trust boundary as the user themselves; an attacker that can run code as the user has already bypassed any JWT we could mint.
- This matches final-architecture's "single user, single identity" principle (#10).
- JWT on Listener A would be ceremony with no security value (client and server share UID).

## Cross-refs

- [02 — Process topology (address discovery / spawn)](./02-process-topology.md)
- [04 — Listener B (the other listener)](./04-listener-B-jwt.md)
- [07 — Connect server scaffold (mount + interceptor wiring)](./07-connect-server.md)
- [09 — PTY host (`ccsm_native` shared binding)](./09-pty-host.md)
- [12 — Electron thin client (Connect-Node client over UDS / named pipe)](./12-electron-thin-client.md)
- [14 — Deletion list (trace-id-map removed because trace-id is server-issued)](./14-deletion-list.md)
- [15 — Testing strategy (peer-cred UT matrix)](./15-testing-strategy.md)
