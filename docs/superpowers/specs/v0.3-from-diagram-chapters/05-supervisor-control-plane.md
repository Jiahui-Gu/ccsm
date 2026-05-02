# 05 — Supervisor control plane (envelope retained, hello-HMAC stripped)

## Scope

The supervisor control plane keeps the v0.3 length-prefixed JSON envelope unchanged from the previous v0.3 design — with **one breaking change**: hello-HMAC is removed.

**Why retain envelope here:** final-architecture §2 principle 8 explicitly partitions the wire surface. The supervisor RPC set is small, control-plane-only, and never multi-client. Migrating it to Connect-RPC would buy nothing and risk regression in the daemon's lifecycle path. The split is the architecture's intentional asymmetry.

## Surface (5 RPCs + 1 probe)

| Method                       | Direction                | Purpose                                                                |
| ---------------------------- | ------------------------ | ---------------------------------------------------------------------- |
| `GET /healthz`               | client → daemon (HTTP-style probe over the same UDS) | liveness; supervisor / Electron uses for readiness gate           |
| `GET /stats`                 | client → daemon          | basic introspection (uptime, listener bind status, version)            |
| `daemon.hello`               | client → daemon (RPC)    | handshake; returns daemon version + bootNonce + listener addresses     |
| `daemon.shutdown`            | client → daemon (RPC)    | graceful shutdown                                                      |
| `daemon.shutdownForUpgrade`  | client → daemon (RPC)    | graceful shutdown that writes an upgrade marker (see "Marker" below)   |

These match the v0.3 reconciliation `#69` "implement SUPERVISOR_RPCS handlers + supervisor /healthz ping" verdict (KEEP/MODIFY: ship the five handlers, strip HMAC).

## Transport

- Same OS-specific UDS / named pipe family as Listener A, but a **separate socket**: `<runtimeRoot>/ccsm-control.sock` on POSIX, `\\.\pipe\ccsm-control-<cwdHash>-<uidHash>` on Windows.
- Peer-cred is enforced on the supervisor socket using the same mechanism as Listener A (see [03 §peer-cred](./03-listener-A-peer-cred.md)). Same-UID only.
- Wire format: existing v0.3 length-prefixed JSON envelope. Frame format, deadline interceptor, base64url helpers, supervisor-rpcs registry, protocol-version handshake — **all retained** (see [14 §"Files KEPT in `daemon/src/envelope/`"](./14-deletion-list.md)).

**Why a second socket (not multiplexed onto Listener A):** the v0.3 design (frag-3.4.1.h) already separates control from data so a snapshot fan-out cannot starve the supervisor heartbeat. Final architecture preserves this split (the diagram shows them as distinct lanes).

## hello-HMAC removal

### Why remove it

The pre-final-architecture v0.3 design (see stale `v0.3-fragments/frag-3.4.1`) used a HMAC challenge-response on `daemon.hello` to bind clients to a per-installation `daemon.secret`. The architecture replaces this with **transport-bound trust**:

- Same-machine clients are trusted by peer-cred (Listener A + supervisor socket). HMAC is redundant.
- Remote clients are trusted by CF-Access JWT (Listener B). HMAC is irrelevant.

Keeping HMAC means an extra surface that proves nothing the OS doesn't already prove. Final-architecture principle 5: "Backend never issues its own tokens." HMAC = self-issued token. Out.

### What goes

- `daemon/src/envelope/hello-interceptor.ts` — DELETE (see [14](./14-deletion-list.md)).
- `daemon/src/envelope/hmac.ts` — DELETE.
- `<dataRoot>/daemon.secret` — no longer written by daemon, no longer read by clients. Migration: on daemon boot, **delete the file if present** (cleanup; do not preserve dead state).
- `daemon/src/envelope/boot-nonce-precedence.ts` — DELETE (the boot-nonce escalation rule was an HMAC-coupled invariant; bootNonce itself is retained as a plain field on `daemon.hello` response for client reconnect detection).
- All HMAC-related env vars / flags removed (no flag lingers as "off by default"; the code is gone).

### What stays in `daemon.hello`

Response body (JSON envelope):
```json
{
  "ok": true,
  "version": "0.3.0",
  "bootNonce": "01HXZ...",
  "listenerA": { "transport": "uds", "path": "..." },
  "listenerB": { "transport": "tcp", "host": "127.0.0.1", "port": 53421 },
  "supervisor": { "transport": "uds", "path": "..." },
  "schemaVersion": 1
}
```

Client uses the response to:

- Confirm version / schema compatibility.
- Detect daemon restart by `bootNonce` change → triggers Connect-RPC reconnect + session resubscribe with snapshot replay (see [08 §"Resubscribe"](./08-session-model.md)).
- Discover Listener A address (redundant with discovery file but allows hello-only bootstrap).

There is **no challenge, no nonce-from-client, no signing**. Just plain identification.

## `/healthz` semantics

- Returns `200 OK` with `{ "ok": true, "version": "0.3.0", "bootNonce": "...", "listenersBound": { "A": true, "B": true, "supervisor": true } }`.
- All three listener bind statuses MUST be `true` for healthz to return ok. If Listener B is bound but JWKS pre-warm has not completed, healthz still reports ok (JWKS pre-warm is not a v0.3 readiness gate; see [04 §"Bind-gate"](./04-listener-B-jwt.md)).
- Probe path: HTTP/1.1 over the UDS / pipe (the supervisor socket carries both envelope-RPC frames and a tiny HTTP/1.1 healthz dispatcher; same as v0.3 design's split).

## `/stats` semantics

- Returns `{ uptime_s, sessions_active, pty_children, rss_bytes, version, bootNonce, listenersBound }`.
- No PII, no per-session data. Used by dogfood smoke (see [15 §dogfood](./15-testing-strategy.md)).

## `daemon.shutdown` semantics

- Acknowledged before exit. Daemon then closes Listener A + Listener B + supervisor socket (in that order — data plane first to drain in-flight RPCs), waits up to 5 s for sessions to flush, then exits 0.
- Marker file (see below) is **not** written by `daemon.shutdown`.

## `daemon.shutdownForUpgrade` semantics

- Same as `daemon.shutdown` plus: writes `<dataRoot>/daemon.shutdown` marker file containing `{ "reason": "upgrade", "expectedRespawnUntil": "<ISO8601 + 60s>", "ulid": "..." }` atomically.
- Supervisor / OS service unit (when present) reads the marker on observed-exit; if present and within `expectedRespawnUntil`, restart is **silent** (no crash-loop counter increment). Out of window or marker malformed → treat as crash.
- v0.3 has no installed OS supervisor; the marker is read by Electron-side respawn logic (which decides whether to show a crash-loop modal). Same semantics; v0.4 adds a second reader (the OS supervisor).

**Why marker:** auto-update / upgrade-in-place writes the new daemon binary, calls `daemon.shutdownForUpgrade`, daemon exits, supervisor sees marker → respawns the new binary silently. This is the v0.3 frag-6 design preserved.

## Interceptor chain on supervisor socket

In order:
1. **Peer-cred** (same as Listener A; reject before reading any envelope frame).
2. **Deadline** (existing v0.3 deadline interceptor in `daemon/src/envelope/deadline-interceptor.ts` — KEEP per [14](./14-deletion-list.md)).
3. **Migration gate** (existing v0.3 `migration-gate-interceptor.ts` — KEEP; the supervisor RPC allowlist that lets `daemon.hello` / `shutdown*` / `/healthz` / `/stats` through during DB migration).
4. **Logging** (per-RPC structured log).

There is **no** hello-HMAC interceptor (deleted). There is **no** trace-id-map interceptor (deleted; trace-id is server-issued).

## Migration from v0.2 supervisor

Existing v0.2-shaped clients (none ship outside dev) would fail `daemon.hello` HMAC check → broken. Acceptable: there are no external v0.2 envelope clients in the wild; the only user is the v0.2 Electron app, which is being replaced by the v0.3 Connect-flipped Electron in the same release. No backward compat shim.

## Cross-refs

- [01 — Goals (G3)](./01-goals-and-non-goals.md)
- [02 — Process topology (shutdown / lifecycle / marker semantics)](./02-process-topology.md)
- [03 — Listener A (peer-cred shared mechanism)](./03-listener-A-peer-cred.md)
- [07 — Connect server (separate from supervisor; do not confuse)](./07-connect-server.md)
- [12 — Electron thin client (consumes hello + bootNonce, drives shutdownForUpgrade)](./12-electron-thin-client.md)
- [14 — Deletion list (envelope files KEPT vs DELETED)](./14-deletion-list.md)
