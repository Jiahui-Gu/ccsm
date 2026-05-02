# R3 review — 04-proto-and-rpc-surface

## P1-R3-04-01 — No Health RPC on data plane

R3 angle 21. The proto surface has no `HealthService.Check()` (gRPC-standard health-check protocol). Supervisor `/healthz` exists (chapter 03 §7) but is HTTP-only and only reachable via the supervisor UDS, not Listener A. For:

- Installer post-install verification of the data plane (currently uses Supervisor — adequate for v0.3 but inconsistent),
- Future v0.4 web/iOS clients that have NO supervisor access at all,
- Manual debugging via Connect tooling against the same surface clients use,

Recommend adding a `HealthService` proto + RPC. Forever-stable trivially (status enum + service-name string). Better to add now than retrofit in v0.4. P1 because the supervisor backstop covers v0.3 only.

## P2-R3-04-02 — `PtyHeartbeat` cadence locked at "10s" in proto comment, not in proto

§4 `PtyHeartbeat` documents "every 10s when no other frame; lets client detect stall" in a comment. The cadence is part of the wire contract — if a v0.5 server changed it to 30s, a v0.3 client with a 15s timeout would spuriously disconnect. Either:

- Make the cadence a field on the heartbeat (server tells client "next heartbeat in N ms") so client adapts, OR
- Promote the 10s to a normative constant in the spec (not just a code comment) so reviewers can cite it.

## P2-R3-04-03 — `WatchSessions` and `WatchCrashLog` have no heartbeat at all

§3 `WatchSessions` and §5 `WatchCrashLog` are server-streams that emit only on event. No keepalive frame. R3 angle 12: a healthy-but-idle stream is indistinguishable from a dead stream. Two options:

- Mirror the `PtyHeartbeat` pattern: add a heartbeat oneof variant to `SessionEvent` and `CrashEntry` envelope (e.g., `oneof { Session created; ...; Heartbeat heartbeat; }`).
- Rely on transport-layer keepalive (HTTP/2 PING — see R3-03-01).

The application-layer option matches the PTY pattern and is forever-stable without needing transport keepalive to be reliable through future intermediaries (a CF Tunnel in v0.4 may strip HTTP/2 PINGs).

## NO FINDING — additivity contract (§7-8)

The forever-stable / open-string-set discipline is reliability-positive (clients tolerate unknown values without crashing).

## NO FINDING — `Hello` version negotiation (§3)

`HelloResponse.proto_version` + `HelloRequest.proto_min_version` covers daemon/client version skew per R3 angle 14 / chapter 02 §6 cross-ref.

## NO FINDING — `RequestMeta.request_id` (§2)

UUIDv4 per request enables log correlation — supports R3 logging spec when it lands (see chapter 09 R3 review).
