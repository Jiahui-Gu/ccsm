# Review of chapter 03: ptyHost wiring

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P0-1 (BLOCKER): Option C decision lacks measured cold-launch budget; A/B/C trade-off is asserted, not demonstrated

**Where**: chapter 03, §3 "Daemon-port readiness (HP-3)" — Implementation choice subsections (Option A/B/C) and "Decision" (lines 132-188).
**Issue**: Author flagged this as Q2 for R3. The decision text says Option C "is sub-second on every measured platform" but no measurements are cited and no baseline harness case is added. Three independent reliability risks:
  1. **Cold-start regression on slow CI runners**: GH-actions Linux runners spin up a fresh node child + load `daemon/main.ts` (which auto-registers all `daemon/api/*.ts` siblings — chapter 01 HP-11). Plausible 1-3s on cold disk cache.
  2. **First-RPC race after await**: chapter 03 explicitly handwaves "`getDaemonPort()` could theoretically return null on extreme bad luck between the await and the first RPC" and *keeps* the 5s poll as fallback. But no design says WHY this race exists if Option C truly awaits resolution. If `spawnDaemon` returns the port atomically and `setDaemonPort(port)` runs before `await spawnDaemon` resolves, the race cannot exist; if it can, the contract is broken.
  3. **Hard failure path**: if `await spawnDaemon()` throws (port occupied, EACCES on Windows where another stale daemon owns the port — see also chapter 01 HP-12), the unhandled rejection in `electron/main.ts` will crash electron with a stack trace and zero user-visible explanation. There is no fallback or retry.
**Why this is P0**: this is the single most-touched cold-path and a foreseeable v0.3 incident class. Shipping with the current §3 text guarantees at least one "electron just doesn't open" report on a developer box that has a stale daemon, and the developer has no recovery path other than `pkill node`.
**Suggested fix**: chapter 03 §3 must add three subsections before the "Decision":
  - `### Cold-spawn budget (measured)` — table with p50/p95 spawn-to-port-ready timings on Windows / macOS / Linux CI runner. Block on this before committing Option C.
  - `### Spawn failure path` — explicit policy: catch around `await spawnDaemon()`, log structured stderr `[ccsmd] <iso> error spawn: <reason>`, then ONE retry after 1s with port = 0 (let OS pick), then if still failing show a native error dialog `Failed to start ccsm daemon: <reason>. Try restarting the app.` and exit non-zero. NO silent fallback.
  - `### Race after await — eliminate or document` — either prove the race cannot happen (in which case shorten the bridge fallback to 0 iterations and assert null is unreachable) or pin the worst-case window with a typed log line.

### P0-2 (BLOCKER): SSE G-4 reconnect contract delegates "catch up" to renderer with no implementation contract

**Where**: chapter 03, §2 "SSE event delivery" guarantee G-4 (lines 84-88).
**Issue**: G-4 says "SSE auto-reconnect MUST NOT replay events the renderer already received. Daemon SHOULD treat reconnection as 'open new tail; renderer is responsible for catching up via attach if it cares.'" But the renderer-side contract is missing entirely:
  - When does the renderer's `EventSource` emit a `close`/`error` reconnection signal that triggers a `ccsmPty.attach` re-fetch?
  - How does the renderer dedupe a `pty:data` event arriving immediately before the disconnect with the snapshot returned by re-attach (the snapshot includes that byte; the live tail starts after that byte — but if the disconnect was after `pty:data` left daemon and before it reached renderer, renderer dedup must compare buffer cursor positions)?
  - During the reconnect window, what happens to user `input` RPCs — are they buffered or dropped?
**Why this is P0**: SSE is *the* live data plane. A single transient SSE disconnect (laptop sleep, dev-tools open in electron, GC pause) under the current spec produces either silent data loss or duplicate replay. The harness `attach-replay-from-headless-buffer` covers the daemon-snapshot path but NOT the live-then-disconnect-then-reconnect path. This will incident in v0.3.
**Suggested fix**: §2 add a new subsection "G-5 Reconnect dedup contract":
  - The renderer's `EventSource.onerror` MUST issue `ccsmPty.attach(sid)` and treat the response snapshot as authoritative for "everything up to now". Live-tail SSE events received between disconnect and re-attach are discarded.
  - `ccsmPty.attach` MUST return `{ snapshot, snapshotLastSeq: number }` where `seq` is a monotonic per-sid counter daemon increments per emitted byte chunk.
  - SSE `pty:data` events MUST carry `seq`. Renderer ignores any `seq <= snapshotLastSeq` after re-attach.
  - User `input` during reconnect window: renderer queues, flushes after re-attach success. Queue size cap 64KB; on overflow, surface error toast.

UT additions in `daemon/api/__tests__/pty.test.ts` (or extend `dataFanout.test.ts`):
  - `seq` monotonicity across emit + snapshot inclusion.
  - Reconnect mid-stream: renderer dedup correctness.

### P1-1 (must-fix): sigkill-reattach buffer TTL is unspecified beyond "60s" example

**Where**: chapter 03, §4 "sigkill-reattach (HP-8)" Implementation responsibilities (lines 217-224).
**Issue**: The text says "retain the pre-kill buffer for the sid until either (a) the renderer issues `detach` and never reattaches before a TTL (e.g. 60s), or (b) ...". `e.g.` is not a contract. No defined behaviour for: TTL chosen value, what happens if attach arrives at TTL+1ms (race), memory cap on the buffer (a runaway pty could have 100MB scroll), eviction policy under memory pressure.
**Why this is P1**: incorrect TTL means real users lose scrollback after a flaky network blip; too-long TTL means OOM under many sessions. Both reliability/observability concerns.
**Suggested fix**: pin TTL = 60s as MUST. Add MUST: buffer size cap = 1MB per sid (xterm scrollback default ~1000 lines × ~80 chars = sufficient for scrollback). On cap exceeded, daemon truncates oldest bytes (treat as ring buffer). On TTL eviction, daemon logs `[ccsmd] <iso> info pty: snapshot evicted sid=<sid> bytes=<n> age_ms=<n>`.

### P1-2 (must-fix): three RPCs error-token taxonomy is incomplete

**Where**: chapter 03, §5 "Three real RPCs" subsections + §6 "Error surface conventions" (lines 246-308).
**Issue**: §6 lists `no_such_sid`, `bad_request`, `spawn_failed` as examples but the per-RPC subsections only mandate `no_such_sid`. Missing: `daemon_unavailable` (HP-3 fallback path), `pty_dead` (write after exit but sid not yet GC'd — different from no_such_sid), `claude_resolver_timeout` (claudeResolver hung). Without enumeration, each RPC fixer invents their own.
**Why this is P1**: error-token drift across RPCs makes renderer error-handling brittle; tests that assert on tokens will diverge.
**Suggested fix**: §6 add a closed enum:
```
type ErrorToken =
  | 'no_such_sid'        // sid not in registry
  | 'pty_dead'           // sid exists but pty exited; caller may attach for replay
  | 'bad_request'        // validation failure
  | 'spawn_failed'       // pty.spawn rejected
  | 'daemon_unavailable' // bridge timed out reaching daemon (renderer side)
  | 'internal'           // fallback; daemon logs full error, renderer shows generic toast
```
Per-RPC subsections in §5 must enumerate which subset they emit.

### P1-3 (must-fix): no LOG_LEVEL / structured-log contract

**Where**: chapter 03, §6 "Error surface conventions" and §7 "Out-of-scope".
**Issue**: §6 defines wire-level error tokens but does not require structured stderr logging on daemon side. §7 defers nothing log-related; there is no signal where logging IS in scope. Cross-cuts with chapter 00 P1-2.
**Why this is P1**: when the e2e harness reports "5s timeout on attach", the only diagnostic today is harness Playwright trace. Daemon may have already logged "spawn rejected: ENOENT claude binary" but it is in the void. v0.3 SHOULD ship at minimum a `LOG_LEVEL` env var (default `info`) and a single-format stderr line.
**Suggested fix**: add §6 subsection "Daemon stderr format":
  - All daemon log lines: `[ccsmd] <ISO-8601-Z> <level> <category>: <message> <key=value...>` where level ∈ `debug|info|warn|error`, category is the module short name (`pty`, `data`, `spawn`, `api`).
  - `process.env.CCSMD_LOG_LEVEL` controls minimum level; default `info`. Harness CI sets `debug`.
  - Electron main forwards daemon stderr to its own stderr verbatim. Harness-runner captures both per-case (cross-ref chapter 04).

### P2-1 (nice-to-have): SSE single per-sid stream model is not a reliability concern, but worth re-affirming

**Where**: chapter 03, §7 "Out-of-scope" (lines 310-316).
**Issue**: Out-of-scope says "Multiplexing all sids onto a single SSE stream: not blocking; current per-sid model is simple and the bug isn't here." Reliability angle: per-sid means N sessions = N sockets = N file descriptors. For a power user with 30 sessions, this is fine. For a stress test, fd exhaustion is a real ceiling.
**Why this is P2**: not a v0.3 incident risk for normal use; documentation only.
**Suggested fix**: add a one-line MAY-budget: "MAY: daemon SHOULD warn-log when active SSE sockets exceed 50 (`fd_warn_threshold`). HARD ceiling deferred to v0.4."

## Cross-file findings

- P0-1 (cold-spawn budget) blocks PR-3 dispatch; the budget table itself is also referenced by chapter 01 P1-2 and chapter 05 Risk-1. One fixer should own the cross-chapter measurement-and-decision flow.
- P0-2 (SSE reconnect dedup) requires UT additions in chapter 03 §2 + new harness case in chapter 04 §4 + new "loadstate-roundtrip-equivalent" SSE roundtrip case. Single fixer.
- P1-2 (error-token enum) is referenced from chapter 02 §3 (loadState rejection) and probe-utils dump format. Coordinate.
- P1-3 (log format) cross-cuts chapter 00 P1-2 and chapter 04 §2.
