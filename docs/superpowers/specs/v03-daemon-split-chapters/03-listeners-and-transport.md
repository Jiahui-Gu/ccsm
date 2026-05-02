# 03 — Listeners and Transport

v0.3 ships exactly one runtime listener (Listener A) plus a Supervisor UDS, but the daemon's listener subsystem is structured as a `Listener` trait + an array of slots, with slot 1 reserved for v0.4's Listener B. This chapter pins the trait shape, the v0.3 instantiation, the auth middleware composition, and the loopback HTTP/2 transport pick — including the explicit MUST-SPIKE alternatives the brief demands rather than a TBD.

### 1. Listener trait

A `Listener` is a (socket address, transport, auth middleware chain, RPC mux) bundle owned by the daemon. The trait is a TypeScript interface:

```ts
// packages/daemon/src/listeners/listener.ts
import type { ConnectRouter } from "@connectrpc/connect";

export interface Listener {
  readonly id: "A" | "B";              // slot id; v0.3 only "A" used
  readonly bind: BindDescriptor;        // UDS path or loopback host:port
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

export type ListenerSlot = Listener | null; // null = reserved, not yet instantiated
```

The daemon owns a fixed-length array `listeners: [ListenerSlot, ListenerSlot] = [null, null]`. v0.3 fills slot 0; slot 1 stays `null`. v0.4 fills slot 1 — **no array reshape, no factory rename, no trait change**.

> **Why fixed array (not Map)**: a Map keyed by string would let v0.4 add arbitrary listener ids and tempt reshape. A 2-slot array makes the topology a static fact reviewers can audit; v0.5+ "Listener C" requires an explicit spec amendment.

### 2. Listener A — instantiation

```ts
// packages/daemon/src/listeners/listener-a.ts
export function makeListenerA(env: DaemonEnv): Listener {
  return {
    id: "A",
    bind: env.platform === "win32"
      ? { kind: "named-pipe", path: `\\\\.\\pipe\\ccsm-${env.userSid}` }
      : { kind: "uds", path: env.platform === "darwin"
          ? "/var/run/ccsm/daemon.sock"
          : "/run/ccsm/daemon.sock" },
    authChain: [
      peerCredMiddleware(),       // produces principal { kind: "local-user", uid, sid }
      jwtBypassMarker(),          // no-op in v0.3; explicit marker so audits see it
    ],
    start, stop,
  };
}
```

Auth chain order matters: peer-cred MUST run first to set `ctx.principal`. The `jwtBypassMarker` is a no-op middleware whose only purpose is to make the bypass explicit in code review and to occupy the same composition position the JWT validator will occupy on Listener B (see §6).

### 3. Connection descriptor handed to Electron

Daemon writes a JSON file at a known per-OS path on every successful Listener A bind:

- Windows: `%LOCALAPPDATA%\ccsm\listener-a.json` (or `%PROGRAMDATA%\ccsm\listener-a.json` if cross-user; MUST-SPIKE [win-localservice-uds] in [02](./02-process-topology.md) §2.1 decides).
- macOS: `/Library/Application Support/ccsm/listener-a.json`.
- Linux: `/run/ccsm/listener-a.json`.

```json
{
  "version": 1,
  "transport": "h2c-uds" | "h2c-loopback" | "h2-tls-loopback" | "h2-named-pipe",
  "address": "/run/ccsm/daemon.sock" | "127.0.0.1:54871" | "\\\\.\\pipe\\ccsm-S-1-5-21-...",
  "tlsCertPemBase64": "..." | null,
  "supervisorAddress": "/run/ccsm/supervisor.sock" | "127.0.0.1:54872"
}
```

The descriptor exists so the transport choice can change between OSes (or even between installs after a spike outcome) without changing Electron code: Electron reads the file, picks a Connect transport factory by `transport`, and connects. The `version: 1` field is forever-stable — additions go in new top-level fields.

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

### 6. Listener B — stub slot (v0.3)

```ts
// packages/daemon/src/listeners/listener-b.ts
// v0.3: this file exists, exports the type, but the factory THROWS if called.
export function makeListenerB(_env: DaemonEnv): Listener {
  throw new Error("Listener B not implemented in v0.3 (reserved for v0.4)");
}
```

The daemon startup code MUST contain the exact line `// listeners[1] = makeListenerB(env);  // v0.4` as a code comment, not as live code. **Why a code comment, not a feature flag**: brief §1 says "no JWT middleware code shipped" — a runtime flag would require shipping the JWT validator. v0.4 deletes the comment, removes "throw" from `makeListenerB`, and adds the JWT middleware module. That is purely additive code (new module file) plus a one-line uncomment.

### 7. Supervisor UDS

Separate from data-plane Listener A. v0.3 endpoints:

- `GET /healthz` → 200 with body `{"ready": true, "version": "0.3.x", "uptimeS": N}` once startup step 5 (per [02](./02-process-topology.md) §3) completes; 503 before.
- `POST /hello` → records caller PID + version; admin-only (peer-cred uid check); used by installer post-register verification.
- `POST /shutdown` → admin-only; triggers graceful shutdown path; used by uninstaller.

Why HTTP and not Connect on the supervisor: it predates the Connect surface in startup order (must answer before Listener A binds), and these three endpoints are forever-stable, single-purpose, and benefit from being callable by `curl` from the installer / a postmortem shell. Bind path mirrors Listener A's UDS conventions but `daemon.sock` → `supervisor.sock`.

### 8. v0.4 delta

- **Add** `makeListenerB(env: DaemonEnv): Listener` real implementation: `bind = { kind: "loopback-tcp", host: "127.0.0.1", port: PORT_TUNNEL }`, authChain `[jwtValidatorMiddleware()]`. Listener trait: unchanged. Listener array shape: unchanged (slot 1 filled).
- **Add** new auth middleware module `jwt-validator.ts`. Composition position is the same slot the `jwtBypassMarker` occupied on Listener A — review-time symmetry.
- **Add** new fields to `listener-a.json` ONLY if v0.4 needs them (likely none — Listener B has its own descriptor file `listener-b.json`).
- **Unchanged**: trait, peer-cred middleware, Supervisor UDS shape, RPC handler code, Electron transport factory.
