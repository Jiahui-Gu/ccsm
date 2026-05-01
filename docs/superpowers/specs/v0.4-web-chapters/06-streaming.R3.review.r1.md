# Review of chapter 06: Streaming and multi-client coherence

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P0-1 (BLOCKER): Fanout buffer retention TTL/depth unspecified — `fromSeq` replay correctness undefined

**Where**: chapter 06 §6 ("Replay budget cap" + Daemon checks).
**Issue**: §6 says daemon checks "Do I still have `seq >= fromSeq` in my fanout buffer?" — this implies a finite retention window — but the buffer's depth/TTL is never specified. Replay budget says "256 KiB of replay before declaring `gap`," which is a per-replay BURST cap, not the buffer's RETENTION cap. So: how many seq's are retained per session for late-joiners? After session has been live for hours producing MB of output, what's the lower bound of replayable history?
**Why this is P0**: this is the entire correctness model for `fromSeq` reconnect (the success-criterion #4 in chapter 00). Without specifying retention, "client reconnects after 30 minutes" (chapter 07 §3 explicitly mentions this scenario) has indeterminate behavior — possibly always re-snapshots, possibly never re-snapshots. In v0.3 the per-subscriber 1 MiB cap exists but is per-LIVE-subscriber; for late-joiner replay you need a separate per-session "replay history" buffer with documented depth.
**Suggested fix**: §6 add explicit subsection: "Replay buffer: per-session ring buffer of N most recent events OR last M bytes (e.g. 4 MiB rolling). Events older than the ring are unreplayable; reconnect with `fromSeq` older than ring tail forces re-snapshot. TTL is a function of session output rate (~10s of seconds for hot stream, hours for idle)." Cite the actual numbers; show the math against §7's 1 MiB drop-slowest. State explicitly what `currentSeq - fromSeq > N` returns to the client (force snapshot, with what payload).

### P1-1 (must-fix): "Daemon mid-startup, client retries" — no defined backoff or `not_ready` semantics

**Where**: chapter 06 §6 (reconnect flow) + chapter 07 §1 (daemon crash recovery).
**Issue**: After daemon crash + supervisor respawn, daemon goes through SQLite migration (could take seconds), Connect server bind, JWKS prefetch (chapter 05 P1-1 adds this). During this window, web client's reconnect lands on either (a) socket refused (supervisor hasn't bound listener yet), (b) HTTP/2 accepted but Connect handler returns `MIGRATION_PENDING` (per migration-gate interceptor, chapter 02 §8), or (c) JWKS not loaded → `unauthenticated`. All three look different to the client. No documented backoff strategy distinguishes them.
**Why this is P1**: client tight-loop on `MIGRATION_PENDING` thrashes daemon during boot. Or client gives up too quickly thinking it's a real failure. Per chapter 03 §3 the bridge does exp-backoff but doesn't introspect Connect error code to decide retry strategy.
**Suggested fix**: §6 (or new §6.1) define startup-race semantics: `MIGRATION_PENDING` → client retries with longer backoff (e.g. 2s constant for up to 60s) and shows "starting up" banner not "unreachable" banner; `unauthenticated` during boot window → distinguish from JWT-expired by checking `Retry-After` header daemon adds during boot.

### P1-2 (must-fix): Heartbeat-failure detection logic ambiguous

**Where**: chapter 06 §4.
**Issue**: Spec says "if no event (including heartbeat) received for 120s, client treats stream as dead and triggers reconnect." But: (a) does the timer reset on every event (correct) or just heartbeat (broken — would miss high-throughput streams that don't need heartbeats)? (b) what if the daemon's heartbeat scheduler bug means it doesn't emit but the stream is alive (false-positive reconnect storm)? (c) what's the metric for "heartbeats received vs expected" — observability gap.
**Why this is P1**: bad heartbeat logic = either silent stream death OR reconnect storms. Both are user-perceptible.
**Suggested fix**: §4 spec the timer behavior: "client resets liveness timer on EVERY received message (chunk OR heartbeat OR any other oneof variant)." Add observability: bridge logs heartbeat-related reconnects with a distinct trace category so dogfood can detect storms.

### P1-3 (must-fix): Multi-client input ordering — TCP-arrival order is not the same as user-intent order

**Where**: chapter 06 §5 (multi-client coherence) + chapter 07 §6.
**Issue**: §5 says "the daemon's PTY input queue is FIFO in receipt order." With Electron on local socket (microseconds latency) and web on Cloudflare Tunnel (10-40ms RTT per chapter 05 §8), if both type "abc" simultaneously, Electron's keystrokes always arrive first — ordering is dependent on transport latency, not user intent. Spec calls this "matches user expectations for shared session" but in practice the web user perceives lag/lost characters. There's no observable counter of out-of-order or interleaved inputs.
**Why this is P1**: this surfaces in chapter 10 R14 as "user might find this surprising" but it's documented as low-risk. R3 angle: it's also unobservable. Without per-client input counters daemon-side, you can't tell if user reports of "lost keystrokes" are due to input dedup in xterm.js, web-side queue overflow, or actual input drop.
**Suggested fix**: §5 add observability requirement: per-client input counter exposed via `/stats` (cross-ref chapter 05 P2-2) so "I sent 100 keystrokes, daemon recorded 87" is detectable. Document the lag asymmetry explicitly with the latency numbers.

### P2-1 (nice-to-have): No metric on snapshot-storm (concurrent snapshots queued)

**Where**: chapter 06 §5 (snapshot semaphore).
**Issue**: Snapshot semaphore serializes snapshots per session. If many subscribers reconnect simultaneously (chapter 03 P1-2 reconnect choreography) the queue depth and wait time should be observable. None specified.
**Suggested fix**: Daemon emits `pino.debug({ event: 'snapshot_queued', sessionId, queueDepth, waitMs })`. Trivial.

### P2-2 (nice-to-have): `boot_nonce` mismatch should log root-cause hint

**Where**: chapter 06 §6.
**Issue**: When boot_nonce mismatches the daemon force-snapshots. From the user side this looks like a "things flickered." Without a log line saying "boot_nonce mismatch — daemon was restarted" the cause is invisible.
**Suggested fix**: Daemon emits `pino.info({ event: 'force_snapshot', sessionId, reason: 'boot_nonce_mismatch', clientBootNonce, currentBootNonce })`.

## Cross-file findings (if any)

- **Replay buffer retention (P0-1)** ties to chapter 07 §3 (network drop >30 min) and chapter 10 R5 (memory caps). Single fixer for the retention model — needs to balance replay correctness vs memory bound.
- **Startup-race semantics (P1-1)** ties to chapter 07 §1 (daemon crash) + chapter 02 §8 (migration-gate interceptor) + chapter 05 §4 (JWT JWKS). Cross-chapter; one fixer.
