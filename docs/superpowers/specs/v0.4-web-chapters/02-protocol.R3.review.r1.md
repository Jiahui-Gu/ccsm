# Review of chapter 02: Protocol

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): No idempotency story for write RPCs across daemon-crash-mid-RPC

**Where**: chapter 02 §1 + §8 (deadline interceptor row).
**Issue**: §8 covers deadlines and trace-id but never specifies what happens when a unary write RPC (e.g. `RenameSession`, `SendPtyInput`, `SetActive`, `Db.save`) is in flight, the daemon crashes (or the Connect stream RSTs) before the response, and the client retries. With Connect over HTTP/2 + supervisor respawn, retry-after-crash is the expected recovery path (chapter 07 §1). Without idempotency keys or per-RPC documented "at-least-once / at-most-once" semantics, writes can apply twice (e.g. duplicate `userCwds:push`, double `enqueuePending`, double `notify:userInput`).
**Why this is P1**: silent duplication in DB rows / pending-summary queue / cwd MRU is hard to detect post-hoc and corrupts the user's session state. Bug fixes here later require schema changes.
**Suggested fix**: Add §9 "Idempotency model" that classifies every RPC into one of: `naturally idempotent` (reads, `setName`, `setActive` — last-write-wins), `dedup-via-server-key` (writes that need an explicit `idempotency_key` field on the request, daemon dedups within a 60s window), `non-idempotent — must-not-retry` (unary fire that mutates monotonic counters; client surfaces error instead of retrying). Document the classification on each RPC in `proto/`. Reference in chapter 07 §1 daemon-crash recovery.

### P1-2 (must-fix): `buf breaking` override mechanism for intentional breaks (v0.4→v0.5) undefined

**Where**: chapter 02 §4 (CI gates) + §7 (cross-version table).
**Issue**: §7 mentions `ccsm.v2` namespace bump for hard breaks ("we don't expect to do this in v0.4") but the `buf breaking` CI gate is binary — pass or fail. There's no documented escape hatch for the inevitable case where you intentionally break wire compat (e.g. v0.5 retires a deprecated field, or a hot security fix requires removing a leaky field). The current spec implies "you can't merge it" with no override; manager will resort to ad-hoc commits disabling the workflow, which the spec elsewhere (chapter 08 §9 migration-window tolerance) treats as an exceptional case requiring discipline.
**Why this is P1**: at the next minor, manager either (a) ignores the gate (defeats the gate's purpose), (b) finds the override is documentation-less and improvises (risk of silent unsafe merge), or (c) is blocked from a needed change. All three are operational hazards. Reliability-wise this is the "release process has no documented exception path" risk.
**Suggested fix**: Add §4.1 "Intentional breaking changes" — define an override mechanism: PR title prefix `[proto-break]` triggers a separate CI workflow that requires (a) bump to `ccsm.v<N+1>` AND (b) keep `ccsm.v<N>` package generated alongside for one release cycle (allows old clients during deprecation window). Document the deprecation timeline (e.g. v(N) supported for 1 minor release). Without `[proto-break]` prefix, the `buf breaking` gate stays on.

### P2-1 (nice-to-have): Connect interceptor observability not specified

**Where**: chapter 02 §8.
**Issue**: The table lists "deadline interceptor", "trace-id interceptor", "migration-gate interceptor" being re-implemented. No mention of structured logging on each interceptor's reject path (deadline hit / migration gate fired). Without it, debugging "client got `deadline_exceeded`" requires daemon-side stack trace hunting.
**Suggested fix**: Add a sentence "every interceptor that rejects a request emits `pino.warn({ interceptor, method, traceId, reason })`. Same surface as v0.3 envelope interceptors."

### P2-2 (nice-to-have): No retention policy for `~/.ccsm/cloudflared.log` and trace-id ULID volume

**Where**: chapter 02 §8 trace-id row + chapter 05 §1 cloudflared logging.
**Issue**: Trace-id ULIDs are emitted per request. Daemon log will accumulate. Spec mentions "rotated via pino-roll, same convention as daemon log per v0.3 frag-3.7" for cloudflared but not explicitly for the Connect server log. v0.4's higher request rate (heartbeats every 60-90s × N streams + per-keystroke unary input × M sessions) materially increases log volume vs v0.3.
**Suggested fix**: Cite the v0.3 pino-roll cap explicitly in chapter 02 §8 (e.g. "max 50 MB × 5 files = 250 MB ceiling, rotate weekly"); confirm heartbeat events are NOT logged at info level (debug/trace only) to avoid log spam.

## Cross-file findings (if any)

None new from R3 angle on this chapter.
