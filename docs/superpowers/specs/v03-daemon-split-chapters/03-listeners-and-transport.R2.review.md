# R2 (Security) review — 03-listeners-and-transport

## P0

### P0-03-1 — Loopback-TCP transport options (A2/A3) ship NO DNS-rebinding defence

§4 lists A2 (`h2c over loopback TCP`, default for Windows fallback and for any OS where UDS spike fails) and A3 (`h2 over loopback TCP + ALPN + self-signed local cert`). Both bind `127.0.0.1:<ephemeral-port>`. A loopback bind is reachable from any browser tab on the same machine via DNS rebinding (`Host: anything.attacker.example` → resolves to `127.0.0.1` after TTL-expiry rebind). The spec's only authentication on Listener A is **peer-cred** which, on a TCP socket, is "synthesise via `GetExtendedTcpTable` / `/proc/net/tcp` PID lookup → owning uid" (§5). A browser tab is owned by the **same logged-in user** as Electron, so peer-cred says `local-user:<that-user>` and the request is fully authorised.

Nothing in the spec mandates:
1. **`Host:` header allowlist** (e.g., reject if `Host` not in `{localhost, 127.0.0.1, [::1], <descriptor-derived>}`) — the canonical defence.
2. **Random per-session bearer token** in `listener-a.json` echoed in every request (`Authorization: Bearer <descriptor.bearer>`); browser cannot read the descriptor file because it lives in user's filesystem outside browser sandbox.
3. **UDS-only** mandate (drop A2/A3 entirely; force named pipe on Windows).

Without any of (1)/(2)/(3), every TCP-fallback path in the spec is exploitable from a malicious advert or a compromised website. This is the highest-severity finding in the spec.

### P0-03-2 — Peer-cred on loopback TCP is TOCTOU and PID-recycling-vulnerable

§5: "parse `/proc/net/tcp{,6}` ... or `GetExtendedTcpTable(TCP_TABLE_OWNER_PID_ALL)` ... to map remote port → owning PID → owning uid/SID. Rejection if mapping fails." Three problems the spec must address:

1. **Race window**: between `accept(2)` returning and the lookup completing, the connecting process can `exit(2)` and the OS can recycle that ephemeral source port to a different process belonging to a different user. The lookup then attributes the connection to the wrong principal.
2. **`/proc/net/tcp` truncation**: the file is paginated; on Linux it can racily miss entries for sockets in `TIME_WAIT` transitions.
3. **Connection re-use**: HTTP/2 multiplexes many RPCs over one TCP socket. Spec must specify whether peer-cred is resolved per-RPC (expensive, racy on each) or once at accept (then trusted for the connection's lifetime — the latter is what implementations usually do but the spec must say so explicitly because the threat model differs).

Combined with P0-03-1, this means TCP listener has *no* trustworthy auth.

### P0-03-3 — Supervisor "HTTP" transport has no specified auth middleware

§7: Supervisor is plain HTTP, callable by `curl`. `/shutdown` is "admin-only". But §1's `Listener` trait + `authChain` is the daemon's auth abstraction, and the supervisor explicitly is "Why HTTP and not Connect on the supervisor: it predates the Connect surface in startup order". So:
- Where does the supervisor's peer-cred check live (the trait isn't in scope for it)?
- On the Linux/macOS UDS supervisor (`/run/ccsm/supervisor.sock`), `getsockopt(SO_PEERCRED)` is feasible — must be specified.
- On the Windows fallback (`127.0.0.1:54872` per the descriptor schema), peer-cred is PID-lookup — same TOCTOU as P0-03-2, plus same DNS-rebinding exposure as P0-03-1, **on `/shutdown`**. A browser tab can stop the daemon.

Spec MUST: drop loopback-TCP supervisor entirely (UDS-only), and explicitly define the supervisor's peer-cred + uid-allowlist code path.

### P0-03-4 — `listener-a.json` descriptor lacks atomic-write requirement, per-boot nonce, and start-time stamp

§3 specifies the descriptor JSON shape but says nothing about:
1. Write atomicity (temp + rename) so Electron cannot read a torn file.
2. A per-boot nonce / `boot_id` that Supervisor `/healthz` echoes — Electron must verify the descriptor it just read describes the daemon currently answering `/healthz`, not a stale descriptor from a previous boot.
3. A `daemon_start_unix_ms`; Electron rejects descriptors older than the daemon process's start.

Without these, the rendezvous race the brief explicitly calls out (R2 angle 3) is unmitigated. Fix is two new top-level fields in the descriptor (additive, v0.4-safe): `boot_id`, `bind_unix_ms`.

## P1

### P1-03-1 — A3 (TLS+ALPN) leaves private-key handling unspecified

§4: "self-signed local cert in `%PROGRAMDATA%\ccsm\listener-a.crt`". The cert is fine in `%PROGRAMDATA%` (public). But TLS needs a **private key** — never named in the descriptor or §4. Spec must specify:
- Private-key path (probably `%PROGRAMDATA%\ccsm\listener-a.key` with NTFS ACL: LocalService Read, no others).
- Per-install regeneration (NOT shipped in the MSI; each install generates fresh).
- Rotation policy (none in v0.3? Spec must say so explicitly).
- Electron's trust pinning: ch 14 §1.3 says "Electron trusts explicitly via Connect transport's `tls` option (NOT installed in OS root store)". Good — but the trust mechanism is **certificate fingerprint** read from the descriptor, not "trust whatever cert is presented" — must be stated.

### P1-03-2 — `jwtBypassMarker` is described as a no-op; mistakenly removing it is silent

§2: `authChain: [peerCredMiddleware(), jwtBypassMarker()]`. The marker exists "to make the bypass explicit in code review and to occupy the same composition position the JWT validator will occupy on Listener B". Good intent, but if a developer in v0.3 removes the marker, **nothing fails** — the auth chain still works (peer-cred has set the principal). The marker should `assert(env.listenerId === "A")` and throw on every request if not — or better, the marker should `assert(globalThis.__CCSM_LISTENER_ID === "A" && process.env.NODE_ENV !== "v0.4")` — i.e., the marker is load-bearing in some observable way so removing it is a test failure. The brief explicitly calls for `assertNeverInstantiateBInV03()` (R2 angle 11); this marker is the natural place.

### P1-03-3 — Named-pipe DACL on Windows is unspecified

§2 binds named pipe `\\.\pipe\ccsm-${env.userSid}`. Spec doesn't pin the pipe's `SECURITY_DESCRIPTOR`:
- Default DACL on a named pipe created by LocalService grants Everyone Read, which would let any user connect → peer-cred returns the *connecting* user's SID → handler must enforce session-ownership (it does, per ch 05 §4) — fine for sessions, but `Settings`/`CrashLog` are explicitly **not** owner-scoped (ch 05 §5), so any local user can read crash logs and set `claude_binary_path`.
- Spec must specify DACL: `O:SY G:SY D:(A;;GA;;;SY)(A;;GRGW;;;<intended user SID>)`, and the pipe name must include the intended user's SID (already does) AND the daemon must reject connections whose peer SID does not match the SID embedded in the pipe name.

## P2

### P2-03-1 — Multiplexed HTTP/2 over a single peer-cred-validated connection conflates per-RPC principal

If two different sessions on the same machine both invoke Electron-style clients but the OS reuses one HTTP/2 connection (unlikely with separate Electron processes, but possible in v0.4 web-bridge contexts), peer-cred from the connect time stamps every RPC with the same uid. Spec should clarify that peer-cred is per-connection, and that the daemon refuses to multiplex two principals on one connection.

### P2-03-2 — `peerCredMiddleware` failure modes do not distinguish "syscall failed" from "untrusted origin"

§5 final paragraph: "If peer-cred resolution fails ... middleware throws `Unauthenticated`. Electron handles by reconnecting." Reconnect-on-Unauthenticated is fine for Electron, but a malicious caller can use repeated `Unauthenticated` to probe whether peer-cred is resolvable for various PIDs. Rate-limit + structured log entry recommended.

### P2-03-3 — Listener trait's `AuthMiddleware.before` returns updated `HandlerCtx` only via `Promise<HandlerCtx>`; no `after` hook for audit

For the v0.4 JWT path, audit logging of "principal X invoked RPC Y" wants an `after` hook that runs unconditionally. Adding it later is additive but the trait is described as forever-stable; a one-line addition (`after?: ...`) now is cheaper than a v0.4 trait extension that risks "trait reshape" being caught by zero-rework gate.
