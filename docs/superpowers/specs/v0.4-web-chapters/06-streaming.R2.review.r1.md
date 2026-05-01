# Review of chapter 06: Streaming and multi-client coherence

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): No per-session authorization on stream subscribe / input — JWT proves identity but not session ownership
**Where**: chapter 06 §1 (`client.streamPty({ sessionId, fromSeq })`) + §3 (`SendPtyInput { session_id, data }`) + §5 (multi-client coherence)
**Issue**: The single-user model (chapter 01 N2) means there's only ONE authorized identity, so "per-session ACL" is currently moot. But the design treats `session_id` as a server-trusted parameter — any client passing a valid JWT can subscribe to ANY session by guessing/enumerating session IDs. When N2 lifts (v0.7+ per chapter 01), per-session ACL has to be added retroactively, which is a hard refactor. Worse, today's single-user assumption fails the moment the user invites a second person to their tunnel (Cloudflare Access policy adds a second email): both users see ALL sessions.

Additionally: session IDs in v0.3 are presumably ULIDs or UUIDs (not enumerable in practice) — but a leak (log file, screen share, JS error report sent to a hypothetical telemetry endpoint) hands an attacker session-takeover.

**Why this is P1**: forecloses a foreseeable-soon auth gap. Even in v0.4 single-user, an attacker who phishes a JWT can attach to any active session and stream live keystrokes including passwords. Not preventable today, but the spec should note the limitation and pre-design the ACL hook.
**Suggested fix**: 
1. Add to chapter 06 §1: "Every stream/RPC handler MUST call `authorizeSessionAccess(jwtPayload, sessionId)` before delivering data; v0.4 implementation is `return true` (single-user); v0.5+ replaces with per-user ACL. The hook MUST exist from M4."
2. Add to chapter 06 §3 same: `SendPtyInput` handler invokes `authorizeSessionAccess` first.
3. Add chapter 08 contract test placeholder: "session-access-control hook is invoked on every PTY RPC; v0.4 returns true unconditionally; future test will assert wrong-user rejection."
4. Cross-link to chapter 01 N2 with a note: "multi-user enablement requires the `authorizeSessionAccess` hook to be made real."

### P2-1 (nice-to-have): PTY input has no rate cap per RPC — burst flood from compromised client
**Where**: chapter 06 §3 (PTY input model)
**Issue**: Chapter 06 §3 mentions client-side bridge queues to 256 KiB; daemon-side has no documented per-client rate cap on `SendPtyInput`. A compromised client (or attacker with valid JWT) can send 10k input RPCs/sec, filling the per-session PTY input queue and potentially OOMing the daemon. HTTP/2 multiplexing caps streams but not unary RPC rate.
**Why this is P2**: Single-user; low likelihood. Defense-in-depth.
**Suggested fix**: Add to chapter 06 §3: "Daemon enforces per-client SendPtyInput rate: 200 RPCs/sec (burst 1000), exceed → reject with `resource_exhausted`. Per-session PTY input queue capped at 1 MiB; further input rejected until drained."

### P2-2 (nice-to-have): Heartbeat is server-driven and unauthenticated content — could leak liveness to network observer
**Where**: chapter 06 §4
**Issue**: Heartbeat frames are unencrypted at the daemon→cloudflared hop (chapter 05 §5: "Daemon-to-cloudflared is plain HTTP over loopback (no TLS)"). Loopback isn't observable except by local processes — same threat envelope as the local-process trust boundary. Mention only because the design relies on cleartext loopback; a future change to a non-loopback hop (e.g. cloudflared on a different machine on LAN) would expose all stream content.
**Why this is P2**: not exploitable today.
**Suggested fix**: Add to chapter 05 §5 or chapter 06 §4: "Daemon-to-cloudflared link MUST stay loopback-only (`127.0.0.1`); changing this in the future REQUIRES adding TLS or moving to Unix socket." Codify the assumption.

## Cross-file findings

P1-1 (per-session authorization hook) cross-links to chapter 01 N2 and chapter 05 §4 (where the JWT interceptor sets `jwtPayload` in context — that's the input to the hook).
