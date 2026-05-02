# 07 — Connect-Node server scaffold

## Scope

The Connect-Node server is the daemon's data-plane surface. It is bound to **two physically separate listeners** (A + B) using the same handler set but with different interceptor chains.

**Why:** final-architecture §2 principles 3 + 4. Same handlers means there is exactly one implementation of every method; differing interceptors per listener is what makes trust transport-bound.

## Source layout

```
daemon/src/connect/
  index.ts                     # public mount entrypoint, called by daemon boot
  servers.ts                   # creates Listener A + Listener B HTTP/2 servers
  handlers/
    pty.ts                     # PtyService impl
    sessions.ts                # SessionsService impl
    db.ts                      # DbService impl
    crash.ts                   # CrashService impl
    daemon.ts                  # DaemonService impl (Info, SetRemoteEnabled stub, GetRemoteStatus)
  interceptors/
    peercred.ts                # transport-level accept guard for Listener A + supervisor
    cf-access-jwt.ts           # JWT validator for Listener B
    deadline.ts                # per-RPC timeout
    logging.ts                 # structured per-RPC log + server-issued trace-id
  peercred/
    posix.ts                   # SO_PEERCRED / LOCAL_PEERCRED via ccsm_native
    win32.ts                   # named-pipe peer SID via ccsm_native
  jwks/
    cache.ts                   # TTL + cooldown + bind-gate
    fetch.ts                   # HTTP fetch of /cdn-cgi/access/certs
```

## Boot sequence (in `daemon/src/index.ts`)

1. Load config (data root, logger).
2. Open SQLite (run migrations if needed; see [10](./10-sqlite-and-db-rpc.md)).
3. Initialize PTY host module (no children spawned yet; see [09](./09-pty-host.md)).
4. Initialize session manager (empty registry).
5. **Mount supervisor plane** (`daemon/src/envelope/...`; see [05](./05-supervisor-control-plane.md)) — serves `/healthz` immediately, but `/healthz` returns `listenersBound: { A:false, B:false }` until step 6 completes.
6. **Mount Connect data plane** via `daemon/src/connect/index.ts`:
   - Create handler instances wired to PTY host / session manager / SQLite / crash collector.
   - Build router (`@connectrpc/connect-node`'s `connectNodeAdapter` or equivalent).
   - Spin up Listener A HTTP/2 server, bind to UDS / named pipe (see [03](./03-listener-A-peer-cred.md)).
   - Spin up Listener B HTTP/2 server, bind to `127.0.0.1:0`, capture assigned port (see [04](./04-listener-B-jwt.md)).
   - Both listeners MUST be listening before this step returns.
7. Write discovery file (atomic write+rename).
8. Set `/healthz` `listenersBound` flags to true.
9. Log "daemon ready" with all three socket addresses.

If step 6 fails for either listener, daemon exits non-zero with a structured error log. There is no "partially up" state — both listeners ready, or neither.

**Why bind both before discovery file:** consumers of discovery file (Electron + future cloudflared) MUST be able to connect immediately after reading the file. Atomic visibility transition.

## Per-listener interceptor chains

Both listeners mount the same handler set (same `ConnectRouter`). Interceptors differ:

### Listener A interceptor chain

1. **Peer-cred** (transport-level accept guard; rejects before HTTP/2 preface)
2. **Deadline**
3. **Logging** (server-issued trace-id)

No JWT interceptor mounted. (This is enforced by code structure: the `cf-access-jwt` interceptor is registered in the Listener B server constructor only — there is no shared "register all interceptors" function. Two server constructions, two distinct interceptor chains.)

### Listener B interceptor chain

1. **CF-Access JWT** (header validation — see [04](./04-listener-B-jwt.md))
2. **Deadline**
3. **Logging** (server-issued trace-id; identity from JWT attached)

No peer-cred interceptor on Listener B. (Cloudflared connects from same machine but its job is to forward external traffic; peer-cred would falsely permit any local process forging JWT-less requests after compromising cloudflared's own UID. JWT is the only valid trust on Listener B.)

**Why two server instances rather than one shared:** the security-critical invariant "Listener B requires JWT" is impossible to break by accident if the JWT interceptor is hard-wired into Listener B's server construction. A "smart" router that picks interceptor by listener is one bug away from a shared-interceptor accident. Hard separation > clever routing.

## Stubbed methods (return `Unimplemented`)

The following methods exist in `proto/` but the v0.3 server returns `Unimplemented` (Connect code `unimplemented`):

- `DaemonService.SetRemoteEnabled` — v0.4 wires cloudflared sidecar.
- `DaemonService.GetRemoteStatus` — returns `{enabled:false, sidecar_running:false}` always (does NOT throw `Unimplemented`; it returns a real, accurate v0.3 status).

`SetRemoteEnabled` MUST throw `Unimplemented` rather than silently succeeding. A no-op success would let v0.4 client code "work" against a v0.3 daemon while the sidecar is mute.

## Handler wiring contracts

Handlers are constructed with explicit dependencies (no global / no module-level singletons):

```ts
// daemon/src/connect/index.ts
export function mountConnectPlane(deps: {
  ptyHost: PtyHost;
  sessionManager: SessionManager;
  db: SqliteDb;
  crashCollector: CrashCollector;
  daemonInfo: DaemonInfoProvider;
  jwksCache: JwksCache;
  config: ConnectConfig;
}): { listenerA: Server; listenerB: Server };
```

This is required by the test strategy: handlers are unit-tested by passing fakes.

## HTTP/2 settings

- Listener A (UDS): default HTTP/2 settings; flow control left to libuv defaults.
- Listener B (TCP loopback): explicit `maxConcurrentStreams` cap to bound resource use; no TLS (cloudflared terminates TLS at the edge and forwards plain HTTP/2 to loopback). MUST NOT bind a TLS server on Listener B in v0.3 — TLS on loopback adds no security, costs config (cert paths, expiry), and is not what cloudflared expects.

## Removal of envelope-data-plane bootstrap

The boot sequence above replaces the previous v0.3-design `mountEnvelopeAdapter` + `createDataDispatcher` calls in `daemon/src/index.ts`. Those calls are deleted (see [14 §"Files to delete"](./14-deletion-list.md)). The supervisor envelope mount remains.

## Error code mapping

Connect uses gRPC code mapping. Conventions:

- `Unauthenticated` — JWT failures (Listener B), peer-cred failures (Listener A).
- `PermissionDenied` — reserved; v0.3 has no per-method authz (single user). Not used.
- `NotFound` — session id / db key absent.
- `FailedPrecondition` — daemon in migration state (DB migration in progress).
- `Unimplemented` — `SetRemoteEnabled` in v0.3.
- `Internal` — handler bug; structured log with trace-id.

`FailedPrecondition` during DB migration is the Connect-side mirror of the v0.3 envelope's `MIGRATION_PENDING` short-circuit (see [10 §migration](./10-sqlite-and-db-rpc.md)). Implemented as a small interceptor that consults a "DB ready" gate; reuses the existing migration-gate logic conceptually.

## Cross-refs

- [03 — Listener A](./03-listener-A-peer-cred.md)
- [04 — Listener B](./04-listener-B-jwt.md)
- [05 — Supervisor control plane (separate, runs first)](./05-supervisor-control-plane.md)
- [06 — Proto schema (handler signatures)](./06-proto-schema.md)
- [08 — Session model](./08-session-model.md)
- [09 — PTY host (`PtyHost` dependency)](./09-pty-host.md)
- [10 — SQLite + DB](./10-sqlite-and-db-rpc.md)
- [11 — Crash collector](./11-crash-and-observability.md)
- [14 — Deletion list (envelope data plane mount calls deleted)](./14-deletion-list.md)
