# 01 — Goals and non-goals

## Goals (MUST do in v0.3)

The six goals below are derived directly from the locked principles in [`../2026-05-02-final-architecture.md`](../2026-05-02-final-architecture.md) §2. None is optional. None is "phase 1 of N". Each is shipped at v0.3.0 GA in its v0.4-final form.

### G1 — Two listeners physically bound from day 1

Both listeners are bound at daemon boot, both before the daemon emits its lockfile / readiness signal. **This includes Listener B even though no v0.3 client connects to it.**

- **Listener A:** OS-specific local-only socket (UDS on macOS/Linux, named pipe on Windows). Trust = peer-cred (same-UID).
- **Listener B:** TCP `127.0.0.1:PORT_TUNNEL`. Trust = CF-Access JWT interceptor on every RPC.

Trust is bound to **transport identity** (which listener accepted the connection), never to a request header. A request that arrives on Listener A is peer-cred-trusted regardless of headers; a request on Listener B is JWT-validated regardless of headers.

**Why:** final-architecture §2 principles 3 + 4. Listener B-late-bind would force v0.4 to retrofit a fully-tested interceptor + UT + bind-gate — exactly the rework v0.3 forbids. See [04](./04-listener-B-jwt.md).

### G2 — Connect-RPC over HTTP/2 is the data plane

All session / PTY / SQLite / crash / daemon-info RPC traffic is Connect-RPC, generated from `proto/`. Zero envelope (length-prefixed JSON) code on the data plane. Server runs `@connectrpc/connect-node` HTTP/2.

**Why:** final-architecture §2 principle 8. Envelope-on-data-plane forces full transport rewrite at v0.4. See [06](./06-proto-schema.md), [07](./07-connect-server.md).

### G3 — Supervisor control plane keeps v0.3 envelope

Five RPCs and the health probe stay on the control socket with the v0.3 length-prefixed JSON envelope: `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown`, `daemon.shutdownForUpgrade`. **`daemon.hello`'s HMAC handshake is removed** because auth is now transport-bound (peer-cred or JWT), not header-bound.

**Why:** final-architecture §2 principle 8 explicitly partitions wire surface; supervisor-on-envelope is correct because supervisor RPCs are control-plane lifecycle and never multi-client. hello-HMAC removed because it is now redundant with peer-cred. See [05](./05-supervisor-control-plane.md).

### G4 — Daemon owns its lifecycle

The daemon process is **not a child of Electron**. Closing the desktop client does not stop the daemon. The daemon's PID is not parented to the Electron PID. The Electron app SHOULD be capable of starting the daemon if it is not running, but daemon survival is independent of Electron survival. Daemon respawn is the responsibility of an OS supervisor (launchd / systemd-user / Windows Service); v0.3 does NOT install one but the daemon's lifecycle MUST already work as if one were present.

**Why:** final-architecture §2 principle 9. If daemon is born as Electron's child in v0.3, v0.4 cannot detach without rewriting the lifecycle. See [02](./02-process-topology.md).

### G5 — Session model: backend-authoritative, snapshot+delta, broadcast, LWW, N≥3

PTY host inside the daemon serves every subscribing client with the same `(snapshot, delta-stream)` semantics. Multi-client input is applied to the PTY in arrival order (last-writer-wins) without locks. **Fan-out is N-broadcast from the first commit; no "N=1 first, generalize later" path.** Test matrix MUST include N≥3 concurrent subscribers to the same session.

Scrollback is RAM-only (bounded ring buffer per session); SQLite-backed scrollback is deferred but the in-RAM ring buffer interface MUST already be the seam at which a future persistent layer would slot in (no schema change, no model change).

**Why:** final-architecture §2 principle 7. N=1 PTY would force v0.4 to redesign fan-out + replay semantics. See [08](./08-session-model.md).

### G6 — Electron is a pure thin client

Electron's main process holds zero business logic and zero persistent state. Its only responsibilities: spawn-or-discover the daemon, render the UI, hold a per-session in-memory snapshot cache for renderer reload speed, and OS integration (tray, dock, dialogs, deep-link, notifications). All session/PTY/SQLite/crash interactions go through the Connect client over Listener A.

**Why:** final-architecture §2 principle 2 — "no client is primary; all three consume the same proto". Electron-with-business-logic forces v0.4 to extract that logic to the daemon. See [12](./12-electron-thin-client.md).

## Non-goals (NOT done in v0.3) — but interfaces preserved

Each non-goal below is **deliberately deferred**, not "TBD". For each, the v0.3 surface is shaped so v0.4 can add the deferred piece without modifying v0.3 code.

| NOT done in v0.3                                          | Interface / placeholder v0.3 leaves                                                                | Defer-target version |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | -------------------- |
| `cloudflared` sidecar process management                  | Listener B bound, JWT interceptor live, UT exhaustive, port-discovery contract documented. **No** stubbed `cloudflared` spawn code, no "TODO: spawn sidecar". | v0.4                 |
| Web client (`web/` Vite + connect-web)                    | `proto/` schema contains every service/method web needs                                            | v0.4                 |
| iOS client (connect-swift)                                | Same `proto/` schema; server-streaming methods documented as browser+swift compatible              | v0.4                 |
| OS-level daemon supervisor (launchd / systemd / Windows Service) | Daemon lifecycle is OS-supervisor-ready (G4). Adding the OS unit is a packaging-only delta in v0.4. | v0.4                 |
| Scrollback persistence to SQLite                          | RAM ring buffer interface is the seam; PTY host module API does not bake in "RAM-only" assumptions | v0.5                 |
| Multi-machine semantics                                   | N/A — out of scope of final architecture itself                                                    | not planned          |

**Why deferred (each):**

- cloudflared: deferred to v0.4 because installer/distribution of the binary is its own supply-chain question; gating v0.3 on it would block ship. Listener B + JWT being live is what guarantees zero rework.
- Web/iOS clients: deferred because each is its own packaging problem (static hosting, App Store). Shared `proto/` contract is what guarantees zero rework.
- OS supervisor: deferred because each OS's installer (pkg, deb/rpm, msi/Service installer) is a separate workstream. Daemon-being-detached-from-Electron is what guarantees zero rework.
- Scrollback persistence: deferred to v0.5 because it requires schema design + size-management policy. The in-RAM ring-buffer module shape is what guarantees zero rework.

## Anti-patterns (P0 in PR review)

Any chapter, PR, or implementation that contains the following is an automatic REQUEST-CHANGES and must be fixed before merge:

1. **"Use envelope on data plane now, switch to Connect in v0.4."** Connect is mandatory in v0.3.
2. **"Listener B not bound until v0.4."** Listener B MUST be bound + interceptor live + UT complete in v0.3.
3. **"PTY host serves N=1 client now, generalize to N in v0.4."** PTY host MUST be N≥3-correct from first commit, with N≥3 tests.
4. **"Electron main process keeps a small bit of business logic for now."** All business logic MUST be in daemon. The only state in Electron main is a renderer-reload snapshot cache.
5. **"hello-HMAC stays for compatibility."** hello-HMAC MUST be removed; there are no external clients of the v0.2 envelope.
6. **Any `// TODO v0.4` / `// will be replaced` / `// temporary` / `// for now` comment** in code that ships. (Spec-internal "deferred to v0.4" notes that point to a non-v0.3 chapter are fine.)
7. **"Add this proto field in v0.4."** All v0.4 service surface MUST be present in `proto/` at v0.3.0 ship.
8. **"PTY input flows through Electron then forwards to daemon."** Electron client calls Connect `pty.Input` directly; no shim.
9. **"Daemon is spawned as Electron child via `child_process.spawn` and inherits parent kill."** Daemon MUST be detached from Electron parent (`detached: true`, no inherit, OS-detached on respawn).

## Cross-refs

- [00 — Overview](./00-overview.md)
- [02 — Process topology](./02-process-topology.md)
- [04 — Listener B + JWT](./04-listener-B-jwt.md)
- [06 — Proto schema](./06-proto-schema.md)
- [08 — Session model](./08-session-model.md)
- [12 — Electron thin client](./12-electron-thin-client.md)
- [14 — Deletion list](./14-deletion-list.md)
