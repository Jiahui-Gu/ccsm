# 14 — Deletion list

> Files / modules / RPCs that v0.3 explicitly removes. The reconciliation memo (`../2026-05-02-v0.3-reconciliation.md`) puts the budget at ~1100 LOC of data-plane envelope plumbing; this chapter pins the exact set.

## Files to DELETE in `daemon/src/envelope/`

These are the **data-plane** envelope files. They have no role once Connect-RPC owns the data plane.

| File                                              | LOC (approx) | Why deleted                                                        |
| ------------------------------------------------- | ------------ | ------------------------------------------------------------------ |
| `daemon/src/envelope/adapter.ts`                  | ~250         | Length-prefixed JSON adapter for data plane; replaced by Connect-Node HTTP/2 |
| `daemon/src/envelope/chunk-reassembly.ts`         | ~150         | 16 KiB chunk reassembly for envelope head-of-line; HTTP/2 has native stream framing |
| `daemon/src/envelope/hello-interceptor.ts`        | ~100         | hello-HMAC challenge-response; auth is now transport-bound (peer-cred / JWT)  |
| `daemon/src/envelope/hmac.ts`                     | ~80          | HMAC-SHA256 helpers for hello; not needed                          |
| `daemon/src/envelope/boot-nonce-precedence.ts`    | ~120         | Boot-nonce escalation rule coupled to HMAC; bootNonce as plain field is enough |
| `daemon/src/envelope/trace-id-map.ts`             | ~90          | Client-supplied trace-id mapping; trace-id is now server-issued    |
| `daemon/src/dispatcher.ts` (data-plane half)      | ~200         | Method dispatcher for envelope data RPCs; Connect router replaces it |

Plus matching `__tests__/` files for each.

**Companion deletions (Electron side):**

| File                                              | LOC (approx) |
| ------------------------------------------------- | ------------ |
| `electron/daemonClient/rpcClient.ts`              | ~430         |
| `electron/daemonClient/envelope.ts`               | ~180         |
| `electron/daemonClient/streamHandleTable.ts`      | ~100         |

Total deleted (data-plane envelope budget): **~1700 LOC source + matching tests** (matches reconciliation's "~1100 LOC of data-plane plumbing" with a generous test/source ratio).

## Files KEPT in `daemon/src/envelope/` (supervisor plane)

These are still consumed by the supervisor control plane (see [05](./05-supervisor-control-plane.md)). They MUST NOT be deleted.

| File                                              | Role                                                  |
| ------------------------------------------------- | ----------------------------------------------------- |
| `daemon/src/envelope/envelope.ts`                 | Length-prefixed framing primitives (used by supervisor) |
| `daemon/src/envelope/supervisor-rpcs.ts`          | The 5 supervisor RPC handlers (`/healthz`, `/stats`, `daemon.hello`, `shutdown`, `shutdownForUpgrade`) |
| `daemon/src/envelope/protocol-version.ts`         | Supervisor protocol version negotiation               |
| `daemon/src/envelope/deadline-interceptor.ts`     | Per-RPC timeout (used on supervisor chain)            |
| `daemon/src/envelope/migration-gate-interceptor.ts` | DB-migration short-circuit (supervisor side)         |
| `daemon/src/envelope/base64url.ts`                | Generic helper                                        |

If a kept file has dead code paths after the data-plane removal, those paths come out as part of the same deletion PR (no orphan branches).

## RPCs deleted

| RPC (envelope path)             | Replacement (Connect path)                  |
| ------------------------------- | ------------------------------------------- |
| `ccsm.v1/pty.spawn` (envelope)  | `ccsm.v1.PtyService/Spawn`                  |
| `ccsm.v1/pty.input`             | `ccsm.v1.PtyService/Input`                  |
| `ccsm.v1/pty.resize`            | `ccsm.v1.PtyService/Resize`                 |
| `ccsm.v1/pty.kill`              | `ccsm.v1.PtyService/Kill`                   |
| `ccsm.v1/pty.subscribe`         | `ccsm.v1.PtyService/Subscribe` (server-stream) |
| `ccsm.v1/sessions.*`            | `ccsm.v1.SessionsService/*`                 |
| `ccsm.v1/db.*`                  | `ccsm.v1.DbService/*`                       |
| `ccsm.v1/crash.*`               | `ccsm.v1.CrashService/*`                    |

Note: `daemon.hello`, `daemon.shutdown`, `daemon.shutdownForUpgrade` are NOT deleted — they remain on the supervisor plane.

## On-disk artifacts deleted

| Artifact                              | Reason                                                  |
| ------------------------------------- | ------------------------------------------------------- |
| `<dataRoot>/daemon.secret`            | hello-HMAC removed; daemon deletes file on boot if present |
| Any `<dataRoot>/legacy/*` from v0.2 envelope state | None expected, but boot cleanup MAY scan and remove |

## Tasks impacted (cross-ref reconciliation)

| Reconciliation task | Verdict | Pinned by this deletion list                                 |
| ------------------- | ------- | ------------------------------------------------------------ |
| #67                 | DROP    | adapter cap → adapter file deleted, cap moot                 |
| #70                 | DROP    | rpcClient.ts UT → rpcClient.ts deleted                       |
| #76                 | DROP    | streaming envelope on data-socket → entire data envelope deleted |

## Verification gate

A CI step MUST run after the deletion PR lands:

```
test -f daemon/src/envelope/adapter.ts && exit 1   # must NOT exist
test -f daemon/src/envelope/supervisor-rpcs.ts || exit 1  # must exist
```

(Pseudocode — concrete script in CI YAML.) Same for every file in both tables. This makes "accidentally re-adding the envelope adapter" a hard CI fail.

## Cross-refs

- [05 — Supervisor control plane (KEPT envelope files)](./05-supervisor-control-plane.md)
- [07 — Connect server (replacement of `mountEnvelopeAdapter` calls)](./07-connect-server.md)
- [12 — Electron thin client (electron/daemonClient/* removal)](./12-electron-thin-client.md)
- `../2026-05-02-v0.3-reconciliation.md` (source of the 1100 LOC budget + tasks #67/#70/#76)
