# 03 — Listeners and Transport

v0.3 ships exactly one runtime listener (Listener A) plus a Supervisor UDS, but the daemon's listener subsystem is structured as a `Listener` trait + an array of slots, with slot 1 reserved for v0.4's Listener B. This chapter pins the trait shape, the v0.3 instantiation, the auth middleware composition, and the loopback HTTP/2 transport pick — including the explicit MUST-SPIKE alternatives the brief demands rather than a TBD.

### 1. Listener trait

A `Listener` is a (socket address, transport, auth middleware chain, RPC mux) bundle owned by the daemon. The trait is a TypeScript interface:

```ts
// packages/daemon/src/listeners/listener.ts
import type { ConnectRouter } from "@connectrpc/connect";

export interface Listener {
  readonly id: "A" | "B";              // slot id; v0.3 only "A" used
  readonly bind: BindDescriptor;        // see §1a for the closed-set vocabulary
  readonly authChain: AuthMiddleware[]; // composed in order; produces ctx.principal
  start(router: ConnectRouter): Promise<void>;
  stop(graceMs: number): Promise<void>;
}

export interface AuthMiddleware {
  readonly name: string;
  // returns updated principal or throws ConnectError(code=Unauthenticated|PermissionDenied)
  before(ctx: HandlerCtx, headers: Headers, peer: PeerInfo): Promise<HandlerCtx>;
}

export interface PeerInfo {
  uds?: { uid: number; gid: number; pid: number };
  loopback?: { remoteAddr: string; remotePort: number; localPid?: number };
}

<!-- F2: closes R0 03-P0.1 / R0 03-P1.1 — slot 1 is a typed sentinel, not a `null` comment, with a startup assert + ESLint enforcement. -->
// Reserved-slot sentinel: typed brand symbol exported once from listener.ts.
// v0.3 startup writes RESERVED_FOR_LISTENER_B into slot 1; v0.4's listener-b.ts
// is the ONLY module allowed to overwrite slot 1 (enforced by ESLint rule
// `ccsm/no-listener-slot-mutation`, defined in chapter [11](./11-monorepo-layout.md) §5).
export const RESERVED_FOR_LISTENER_B: unique symbol = Symbol.for(
  "ccsm.listener.reserved-for-listener-b",
);
export type ReservedSlot = typeof RESERVED_FOR_LISTENER_B;

export type ListenerSlot = Listener | ReservedSlot;
```

The daemon owns a fixed-length array `listeners: [ListenerSlot, ListenerSlot]`. At startup, slot 0 is filled with `makeListenerA(env)` and slot 1 is filled with the typed `RESERVED_FOR_LISTENER_B` sentinel. A startup assertion (`assert(listeners[1] === RESERVED_FOR_LISTENER_B, ...)`) throws and aborts daemon boot if any v0.3.x patch overwrites slot 1 with anything other than the sentinel. v0.4 swaps the sentinel for `makeListenerB(env)` — **no array reshape, no factory rename, no trait change**.

> **Why a typed sentinel (not `null`)**: `null` plus a code comment is enforceable only by reviewer attention. The brand symbol makes the slot's identity machine-checkable: TypeScript's type narrowing forces every site that handles `ListenerSlot` to discriminate sentinel vs. `Listener`, the runtime assert catches accidental overwrites, and the ESLint rule (chapter [11](./11-monorepo-layout.md) §5: `ccsm/no-listener-slot-mutation`) forbids any source file other than `listeners/listener-b.ts` from writing to `listeners[1]`. Together these close R0 03-P0.1: a v0.3.x telemetry sidecar / debug listener / hotfix that tries to jam something into slot 1 fails at lint, fails at type-check, AND fails at boot.

> **Why fixed array (not Map)**: a Map keyed by string would let v0.4 add arbitrary listener ids and tempt reshape. A 2-slot array makes the topology a static fact reviewers can audit; v0.5+ "Listener C" requires an explicit spec amendment.

### 1a. BindDescriptor vocabulary (closed set, unified with descriptor `transport`)

<!-- F2: closes R5 P0-03-2 — BindDescriptor.kind and listener-a.json.transport now share one enum vocabulary. -->

`BindDescriptor.kind` is a closed enum stringified identically in `listener-a.json.transport`. The 4-value set is forever-stable for v0.3 (additions in v0.4 ship under a new descriptor file, never as a new enum value):

| `BindDescriptor.kind` | `listener-a.json.transport` | Socket shape | Used by |
| --- | --- | --- | --- |
| `KIND_UDS` | `"KIND_UDS"` | `{ path: string }` (e.g., `/run/ccsm/daemon.sock`) | Listener A on linux/mac when the UDS spike passes |
| `KIND_NAMED_PIPE` | `"KIND_NAMED_PIPE"` | `{ path: string }` (e.g., `\\.\pipe\ccsm-<sid>`) | Listener A on Windows when the named-pipe spike passes |
| `KIND_TCP_LOOPBACK_H2C` | `"KIND_TCP_LOOPBACK_H2C"` | `{ host: "127.0.0.1", port: number }` | Listener A loopback fallback (h2c) |
| `KIND_TCP_LOOPBACK_H2_TLS` | `"KIND_TCP_LOOPBACK_H2_TLS"` | `{ host: "127.0.0.1", port: number, certFingerprintSha256: string }` | Listener A loopback TLS+ALPN fallback |

```ts
export type BindDescriptor =
  | { kind: "KIND_UDS"; path: string }
  | { kind: "KIND_NAMED_PIPE"; path: string }
  | { kind: "KIND_TCP_LOOPBACK_H2C"; host: "127.0.0.1"; port: number }
  | { kind: "KIND_TCP_LOOPBACK_H2_TLS"; host: "127.0.0.1"; port: number; certFingerprintSha256: string };
```

The daemon's `makeListenerA` factory MUST produce a `BindDescriptor` whose `kind` is one of these four; the descriptor writer (§3) MUST stringify the same value into the JSON `transport` field. Electron's transport factory keys on the `transport` string and constructs the matching Connect transport. Any new transport variant in v0.4+ MUST ship as a NEW descriptor file (e.g., `listener-b.json` with its own enum domain), not a new value in this enum (chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern 8).

### 2. Listener A — instantiation

```ts
// packages/daemon/src/listeners/listener-a.ts
export function makeListenerA(env: DaemonEnv): Listener {
  return {
    id: "A",
    bind: env.platform === "win32"
      ? { kind: "KIND_NAMED_PIPE", path: `\\\\.\\pipe\\ccsm-${env.userSid}` }
      : { kind: "KIND_UDS", path: env.platform === "darwin"
          ? "/var/run/com.ccsm.daemon/daemon.sock"
          : "/run/ccsm/daemon.sock" },
    authChain: [
      peerCredMiddleware(),       // produces principal { kind: "local-user", uid, sid }
      // v0.4 inserts the JWT validator here on Listener B; on Listener A the chain stays single-link.
    ],
    start, stop,
  };
}
```

<!-- F2: closes R0 03-P1.3 — jwtBypassMarker dead code removed; chain symmetry documented as a comment on Listener A's authChain literal. -->

Auth chain order matters: peer-cred MUST run first to set `ctx.principal`. v0.3 ships only the peer-cred link; the v0.4 JWT validator on Listener B occupies the next composition slot in `makeListenerB`'s own chain literal (chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern 6 freezes the trait shape so this is purely additive).

### 3. Connection descriptor handed to Electron

<!-- F2: closes R0 03-P0.3 / R2 P0-02-3 / R2 P0-03-4 / R2 P0-08-2 — Windows descriptor path locked unconditionally; atomic write; per-boot nonce; Hello-echo verification. -->

Daemon writes a JSON file at a known per-OS path on every successful Listener A bind. Paths are locked unconditionally (no per-install MUST-SPIKE outcome); the spike validates only that an interactive Electron can read this path:

| OS | Descriptor path | Mode / ACL |
| --- | --- | --- |
| Windows | `%PROGRAMDATA%\ccsm\listener-a.json` (NEVER `%LOCALAPPDATA%`, NEVER `%APPDATA%`) | DACL: `BUILTIN\Users:Read`; `BUILTIN\Administrators:FullControl`; daemon's service account (`NT AUTHORITY\LocalService`) `Modify` |
| macOS | `/Library/Application Support/ccsm/listener-a.json` (system-wide; NEVER `~/Library/...`) | mode `0644`; owner `_ccsm:_ccsm` (group readable so per-user Electron can read) |
| Linux | `/var/lib/ccsm/listener-a.json` | mode `0644`; owner `ccsm:ccsm` (group readable for FHS compatibility) |

Linux NOTE: `/var/lib/ccsm/` is the durable state root (chapter [07](./07-data-and-state.md) §2). The descriptor lives in the durable state dir (NOT `/run/ccsm/`) so Electron can read a stable path that doesn't depend on tmpfs init order; the `boot_id` field below is the per-boot freshness marker, not the path mtime.

#### 3.1 Atomic write discipline

The daemon MUST write the descriptor atomically and exactly once per daemon boot:

1. Write JSON to `listener-a.json.tmp` in the same directory as the final path.
2. `fsync(2)` the temp file.
3. `rename(2)` (or `MoveFileExW(MOVEFILE_REPLACE_EXISTING)` on Windows) `listener-a.json.tmp` → `listener-a.json`. Rename is atomic on every supported FS so Electron never observes a torn file.
4. Daemon does NOT re-write the descriptor within a single boot (no churn from Listener A reconnects). The file's contents identify *this* daemon process; if Listener A restarts within the same daemon process, the address pin and `boot_id` are unchanged.
5. On daemon clean shutdown the file is **left in place**. Orphan descriptor files between boots are normal; Electron's `boot_id` mismatch check (§3.3) handles them. The OS does NOT have to garbage-collect them.

#### 3.2 Descriptor schema (v1, forever-stable)

```json
{
  "version": 1,
  "transport": "KIND_UDS" | "KIND_NAMED_PIPE" | "KIND_TCP_LOOPBACK_H2C" | "KIND_TCP_LOOPBACK_H2_TLS",
  "address": "/run/ccsm/daemon.sock" | "127.0.0.1:54871" | "\\\\.\\pipe\\ccsm-S-1-5-21-...",
  "tlsCertFingerprintSha256": "..." | null,
  "supervisorAddress": "/run/ccsm/supervisor.sock" | "\\\\.\\pipe\\ccsm-supervisor",
  "boot_id": "550e8400-e29b-41d4-a716-446655440000",
  "daemon_pid": 1234,
  "listener_addr": "/run/ccsm/daemon.sock",
  "protocol_version": 1,
  "bind_unix_ms": 1714600000000
}
```

Field semantics (every field is forever-stable; v0.4+ additions go in NEW top-level fields, never as enum widenings):

- `transport` — closed enum from §1a; the daemon and Electron MUST use the same vocabulary.
- `address` — the bind address; format depends on `transport`.
- `tlsCertFingerprintSha256` — SHA-256 fingerprint of the listener's self-signed cert when `transport == "KIND_TCP_LOOPBACK_H2_TLS"`; `null` for all other transports. Electron pins this fingerprint instead of trusting the OS root store (chapter [14](./14-risks-and-spikes.md) §1.3).
- `supervisorAddress` — Supervisor UDS path (mac/linux) or named-pipe path (Windows). Always UDS-shaped; loopback-TCP supervisor is forbidden (§7).
- `boot_id` — random UUIDv4 generated once per daemon boot, held in the daemon's memory for the daemon's lifetime. The freshness witness for Electron's staleness check.
- `daemon_pid` — daemon process pid at the moment of write; observability only (Electron does NOT use this for auth — pids recycle).
- `listener_addr` — duplicate of `address` for grep-friendliness in operator logs; daemon writes the same value.
- `protocol_version` — currently `1`; increments only on a wire-incompatible Connect surface change (forever-stable for v0.3).
- `bind_unix_ms` — daemon process start time in unix milliseconds; observability only.

#### 3.3 Electron startup handshake (mandatory)

Electron MUST follow this exact sequence on every connect (cold start AND every reconnect):

1. Read `listener-a.json` from the locked per-OS path (§3 table). If the file is missing or unparseable, surface "Daemon not running" and retry with backoff.
2. Construct a Connect transport keyed on `transport`, address `address`, plus `tlsCertFingerprintSha256` pin if applicable.
3. Open a connection and **immediately** call `Hello` (chapter [04](./04-proto-and-rpc-surface.md) §3) before any other RPC. The daemon's `Hello` response includes its in-memory `boot_id`.
4. If the descriptor's `boot_id` does NOT equal the `Hello` response's `boot_id`, Electron MUST close the connection, discard the in-memory descriptor, re-read the file from disk, and retry. Two scenarios trigger this mismatch:
   - Stale orphan file from a previous daemon boot the OS didn't clean (the new daemon hasn't yet rewritten the file at the moment Electron read it). Re-reading after backoff catches the new file.
   - Foreign process bound to the recorded address (e.g., a non-CCSM process recycled the same loopback port between daemon crash and Electron read). The `Hello` reaches the foreign process; its response either fails to parse OR returns a different `boot_id` — either way Electron rejects it and never sends `CreateSession.env` / `SendInput` / etc.
5. Once `boot_id` matches, Electron pins the descriptor for this connection's lifetime. If the connection drops (UNAVAILABLE), Electron returns to step 1 (re-reading the file rather than reusing the in-memory copy) so a daemon restart with a new `boot_id` is detected on the very first reconnect attempt.

The daemon side: on every boot, regenerate `boot_id` (never re-use a prior boot's value), rewrite the descriptor before Supervisor `/healthz` returns 200, hold `boot_id` in memory for `Hello` responses. The daemon NEVER trusts the file as input; it is write-once-per-boot from the daemon's POV.

#### 3.4 Why this closes the rendezvous race

- **Atomic write** — Electron cannot observe a torn file (rename is atomic).
- **`boot_id` per boot** — Electron cannot send RPCs to a stale descriptor's address; the `Hello` echo is the witness.
- **Descriptor written before `/healthz` 200** — chapter [02](./02-process-topology.md) §3 step 5 ordering means `Hello` will succeed iff the descriptor Electron just read describes the daemon currently listening.
- **No re-write within a boot** — eliminates the "Electron read mid-write" hazard entirely; the only inter-boot transition is daemon-restart, and that's exactly what `boot_id` mismatch detects.
- **Orphan files between boots are NORMAL** — no installer / shutdown-hook cleanup is required; the `boot_id` mismatch handles them on the next Electron connect attempt.

### 4. Transport — loopback HTTP/2 pick (MUST-SPIKE)

The brief locks "HTTP/2 (same stack as B will be)" and demands concrete alternatives. The pick is per-OS, decided by spike outcome before code lands; the spec lists all four and the cut-over rule:

| Option | Pros | Cons | Decision |
| --- | --- | --- | --- |
| **A1: h2c over UDS** (mac, linux) | no TLS overhead; UDS gives free peer-cred via `getsockopt(SO_PEERCRED)` / `LOCAL_PEERCRED`; widely supported by Node `http2.createServer` | Node `http2.connect` does not natively accept a UDS path — needs custom `createConnection` | **Default for mac/linux** if spike passes |
| **A2: h2c over loopback TCP** (win, fallback elsewhere) | Node `http2` first-class; well-tested | no native peer-cred — synthesize via `GetExtendedTcpTable` (win) / `/proc/net/tcp` (linux) PID lookup; race window between accept and PID resolution | **Default for win** if named-pipe path fails the spike |
| **A3: h2 over loopback TCP + ALPN + self-signed local cert** | TLS path identical to v0.4 Listener B; flushes any TLS-only middleware bugs | cert provisioning + rotation in installer; user OS trust store may complain | **Fallback** if h2c is unsupported by a future Connect server pin |
| **A4: h2 over named pipe** (win) | LocalService → per-user named pipe with DACL is the most idiomatic Windows path | Node `http2` over a named pipe duplex stream is non-trivial; needs custom `createConnection` | **Preferred for win** if MUST-SPIKE [win-h2-named-pipe] passes |

> **MUST-SPIKE [loopback-h2c-on-25h2]**: hypothesis: `http2.createServer({ allowHTTP1: false })` listening on `127.0.0.1` works under Win 11 25H2 with the default Defender Firewall profile (loopback should be exempt). · validation: 25H2 VM, daemon running as LocalService, Electron as logged-in user, run a 1-min smoke (Hello + 100 unary RPCs + a server-stream of 10k events). · fallback: A4 (named pipe + h2). If A4 also fails: A3 (TLS + ALPN) with a per-install self-signed cert in `%PROGRAMDATA%\ccsm\listener-a.crt`, trusted by Electron explicitly (NOT installed in OS root store).

> **MUST-SPIKE [uds-h2c-on-darwin-and-linux]**: hypothesis: Node 22's `http2.connect` can be coerced into using a UDS via `createConnection: () => net.createConnection(udsPath)` and end-to-end Connect-RPC traffic works (unary, server-stream, bidi). · validation: 1-hour soak running the same workload as ship-gate (c) over UDS. · fallback: A2 (h2c over loopback TCP) on the OS where it fails.

> **MUST-SPIKE [win-h2-named-pipe]**: hypothesis: Node 22 `http2.createServer` on a `net.Server` bound to a Windows named pipe works for Connect-RPC. · validation: as above on a 25H2 VM. · fallback: A2 with PID-based peer-cred synthesis.

The transport choice does NOT leak into proto, RPC handlers, or Electron business logic — it lives only in: (a) the daemon's `makeListenerA` factory, (b) Electron's transport factory keyed by the descriptor `transport` field. Switching between A1/A2/A3/A4 is a 2-file diff (zero-rework safe).

### 5. Peer-cred authentication

Peer-cred middleware derives `ctx.principal = { kind: "local-user", uid, sid }`:

| Transport | Mechanism |
| --- | --- |
| UDS (mac) | `getsockopt(LOCAL_PEERCRED)` → `xucred` → uid; daemon's bound user determines what counts as "the local user" — see [05-session-and-principal](./05-session-and-principal.md) §3 |
| UDS (linux) | `getsockopt(SO_PEERCRED)` → `ucred` → pid/uid/gid |
| Named pipe (win) | `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` → SID |
| Loopback TCP | parse `/proc/net/tcp{,6}` (linux) or `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` (win) or `lsof -i` equivalent (mac) to map remote port → owning PID → owning uid/SID. Rejection if mapping fails. |

If peer-cred resolution fails (e.g., process exited between accept and lookup on loopback TCP), the middleware throws `Unauthenticated`. Electron handles by reconnecting.

### 6. Listener B — slot reservation (v0.3 has no `listener-b.ts`)

<!-- F2: closes R0 03-P1.1 — listener-b.ts ships only in v0.4 (additive new file); v0.3 has no makeListenerB symbol to import or refactor. -->

v0.3 deliberately ships **no** `packages/daemon/src/listeners/listener-b.ts` file. The daemon startup writes the typed sentinel `RESERVED_FOR_LISTENER_B` (see §1) into slot 1; no factory is called, no symbol is imported, no `throw` lives in v0.3 code. v0.4 lands a brand-new `listener-b.ts` file (purely additive — chapter [11](./11-monorepo-layout.md) `packages/daemon/src/listeners/` gains one file) plus a one-line edit at the startup site that swaps the sentinel for `makeListenerB(env)`. The ESLint rule `ccsm/no-listener-slot-mutation` (chapter [11](./11-monorepo-layout.md) §5) explicitly whitelists `listeners/listener-b.ts` as the only file allowed to write `listeners[1]` in v0.4+.

> **Why ship no stub in v0.3**: a stub that throws (the prior shape) made `makeListenerB`'s effective return type `never` in v0.3 and `Listener` in v0.4 — a soft signature shift that R0 03-P1.1 flagged. A stub that returns the sentinel still ships an exported symbol whose body v0.4 must rewrite. Shipping the file *only* in v0.4 means v0.3 has zero `listener-b.ts` lines to "modify" — the v0.4 add is a new file plus one startup-site edit, the cleanest possible additive delta.

### 7. Supervisor UDS (UDS-only on every OS, no loopback-TCP fallback ever)

<!-- F2: closes R2 P0-02-2 / R2 P0-03-3 — Supervisor is UDS-only on every OS; loopback-TCP supervisor is forbidden; peer-cred is the sole authn for /shutdown. -->

Separate from data-plane Listener A. The Supervisor channel is **UDS-only on every OS**; loopback-TCP supervisor is forbidden, period. Per-OS bind:

| OS | Supervisor address | Mode / DACL |
| --- | --- | --- |
| Windows | `\\.\pipe\ccsm-supervisor` (named pipe) | DACL: `O:SY G:SY D:(A;;GA;;;SY)(A;;GA;;;BA)(A;;GR;;;BU)` — full control to SYSTEM + Administrators; `BUILTIN\Users:Read` (so the installer / postmortem `curl` can read `/healthz`); only Administrators may invoke `/shutdown` (enforced by peer-cred SID check) |
| macOS | `/var/run/com.ccsm.daemon/supervisor.sock` (LaunchDaemon-managed; reverse-DNS subdir per Apple convention) | mode `0660`; owner `_ccsm:wheel` |
| Linux | `/run/ccsm/supervisor.sock` | mode `0660`; owner `ccsm:ccsm` |

v0.3 endpoints (plain HTTP — Connect framing is overkill for three single-purpose endpoints; HTTP is callable by `curl` from the installer / a postmortem shell):

- `GET /healthz` → 200 with body `{"ready": true, "version": "0.3.x", "uptimeS": N, "boot_id": "<uuid>"}` once startup step 5 (per [02](./02-process-topology.md) §3) completes; 503 before. The `boot_id` field is the same value written into `listener-a.json` (§3.2); operators can correlate.
- `POST /hello` → records caller PID + version; admin-only via peer-cred uid/SID check; used by installer post-register verification.
- `POST /shutdown` → admin-only via peer-cred uid/SID check; triggers graceful shutdown path; used by uninstaller.

#### 7.1 Peer-cred authentication for Supervisor (the ONLY authn — supervisor RPC bypasses JWT forever)

Supervisor RPC bypasses JWT (no JWT validator runs on the Supervisor channel — ever, including v0.4+) and authenticates SOLELY via OS peer-cred:

| OS | Mechanism | Admin allowlist |
| --- | --- | --- |
| Windows | named-pipe peer SID via `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` | SID is in `BUILTIN\Administrators` group; the daemon's own service-account SID (`NT AUTHORITY\LocalService`) is also allowed (so the daemon can call its own Supervisor for self-test / shutdown coordination) |
| macOS | `getsockopt(LOCAL_PEERCRED)` → `xucred` → uid | uid `0` (root) OR `_ccsm` (the daemon's service account) |
| Linux | `getsockopt(SO_PEERCRED)` → `ucred` → uid/gid | uid `0` (root) OR uid of the `ccsm` system account |

`/healthz` requires no admin check (any peer that can reach the socket may probe readiness). `/hello` and `/shutdown` MUST reject non-allowlisted peers with HTTP 403; the daemon logs the rejected peer-cred (uid/SID + pid) to `crash_log` (chapter [09](./09-crash-collector.md)).

#### 7.2 Security rationale (locked)

Supervisor is the only daemon RPC surface that bypasses JWT (because v0.4 cf-access principals MUST NOT be allowed to shut down the daemon — the brief §7 admin/data plane separation). Peer-cred uid match is the sole gate. To make this safe forever:

- **No loopback TCP**: a TCP socket is reachable from any browser tab via DNS rebinding (chapter [03](./03-listeners-and-transport.md) §4 R2 finding); the Supervisor's `/shutdown` cannot afford that exposure. Shipping UDS-only closes the rebinding hole structurally — there's no TCP socket to rebind to.
- **No JWT path**: a future contributor MUST NOT add JWT middleware to the Supervisor "for symmetry with Listener B"; admin actions belong to local admins, not to remote authenticated users. Chapter [15](./15-zero-rework-audit.md) §3 forbidden-pattern locks this: Supervisor endpoints (`/healthz`, `/hello`, `/shutdown`) MUST NOT be exposed via Listener B or any future remote listener; equivalent functionality for remote callers MUST be exposed as new Connect RPCs on the data-plane listener with explicit principal authorization.
- **Service-account self-call allowed**: the daemon's own service-account SID/uid is in the allowlist so the daemon can invoke its own Supervisor (e.g., the integration test harness uses this; chapter [12](./12-testing-strategy.md) §3 covers it).

Bind path mirrors Listener A's UDS conventions but `daemon.sock` → `supervisor.sock` (linux) / `\\.\pipe\ccsm-daemon` → `\\.\pipe\ccsm-supervisor` (Windows).

### 8. v0.4 delta

- **Add** `packages/daemon/src/listeners/listener-b.ts` (NEW file): exports `makeListenerB(env: DaemonEnv): Listener` with `bind = { kind: "KIND_TCP_LOOPBACK_H2C", host: "127.0.0.1", port: PORT_TUNNEL }`, authChain `[jwtValidatorMiddleware()]`. The ESLint rule `ccsm/no-listener-slot-mutation` whitelists this file as the only writer of `listeners[1]`.
- **Edit** the daemon startup site (one line): replace `listeners[1] = RESERVED_FOR_LISTENER_B` with `listeners[1] = makeListenerB(env)`. Listener trait: unchanged. Listener array shape: unchanged (slot 1 filled).
- **Add** new auth middleware module `jwt-validator.ts` (NEW file).
- **Add** new descriptor file `listener-b.json` (NEW file) — Listener A's descriptor and the §1a `transport` enum are unchanged. v0.4 transport variants live under their own descriptor + their own enum domain, never as new values in the v0.3 enum.
- **Unchanged**: trait, peer-cred middleware, Supervisor UDS shape (still UDS-only), RPC handler code, Electron transport factory, descriptor schema (additions only in NEW top-level fields).
