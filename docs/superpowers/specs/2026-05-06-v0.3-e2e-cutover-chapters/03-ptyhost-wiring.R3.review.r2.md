# Review of chapter 03: ptyHost wiring (round 2)

Reviewer: R3 (reliability / observability)
Round: r2

## Round-1 closures

- **P0-1 (Option C cold-launch budget + spawn failure path + race after
  await)** — CLOSED by CF-2 + CF-7. `03-ptyhost-wiring.md` §3 now
  contains four self-contained subsections that together discharge the
  three round-1 risks:
  - "Cold-spawn budget (measured)" pins the 500ms p95 regression
    threshold vs `35b08d15` per platform with an automatic fallback
    to Option B when breached (no manager re-deliberation).
  - "Spawn failure path" pins catch + 1 retry with `port=0` + native
    error dialog + non-zero `app.exit` + no auto-restart + no
    silent fallback. This is the failure-handling contract round-1
    asked for.
  - "Race after await" requires the fixer to either prove the race
    impossible or pin the worst-case window, with the retained
    ≤10-iteration bridge poll as the explicit guard. The race is no
    longer a hand-wave.
  - The 5s poll is also explicitly shortened to 10 iterations with
    "this should never happen post-spawnDaemon-await" as the error
    message so a future regression is debuggable.
  Cross-references with ch00 §3.7 daemon liveness contract and ch05
  PR-3 Acceptance + Risk-1 are consistent.
- **P0-2 (SSE G-4 reconnect contract — renderer-side dedup missing)** —
  CLOSED by CF-6. §2 added G-5 "Reconnect dedup contract" with the
  exact shape requested in round 1: `attach` returns
  `{ snapshot, snapshotLastSeq }`, every `pty:data` carries `seq`,
  renderer drops `seq <= snapshotLastSeq`, user input is queued during
  reconnect (cap 64 KiB; on overflow surface `daemon_unavailable` and
  drop — silent truncation explicitly forbidden), queue is flushed in
  arrival order via the existing `input` RPC after open. UT
  requirements added: 4th case in `dataFanout.test.ts` covers
  subscribe close + reconnect → no replay of pre-close events, queued
  input observed by pty fake exactly once in arrival order. SSE
  reliability invariant is binding at UT tier.
- **P1-1 (sigkill-reattach buffer TTL / cap pin)** — DEFER ACK (CF-3
  manager round-1 decision). Per `feedback_spec_pipeline_review_strictness.md`
  R3 "保必需" gradient and the manager round-1 decision (R1 strict
  preservation prevails), the sigkill TTL=60s pin, 1MB/sid buffer cap,
  ring-buffer truncation, and 4 boundary UTs are explicitly deferred
  to v0.4 and listed in §7 "sigkill-reattach v0.4 follow-up (defer
  list)" as F-1 / F-2 / F-5. The R1 baseline-restoration scope in §4
  is the v0.3 work; no R3-side contract drift in v0.3 because daemon
  retains its v0.2 snapshot behaviour unchanged. Round-2 does NOT
  re-raise this finding.
- **P1-2 (error-token taxonomy incomplete)** — CLOSED by CF-6. §5
  "Error-token enum (closed set, per-RPC subset)" lists the closed
  enum (`no_such_sid / pty_dead / bad_request / spawn_failed /
  daemon_unavailable / internal`) and a per-RPC emit subset table.
  Renderer-bridge-only `daemon_unavailable` is correctly fenced
  (daemon never emits it). The R1 silent-drop precedence note for
  `pty:input` is consistent with the `pty:input` baseline-cite.
- **P1-3 (no LOG_LEVEL / structured-stderr contract)** — CLOSED by CF-6.
  §6 "Daemon stderr structured logs" pins the
  `[ccsmd] <ISO-8601-Z> <level> <category>: <message>` format,
  enumerates levels (debug/info/warn/error) and categories
  (boot/pty/api/lifecycle/internal), pins `CCSMD_LOG_LEVEL` env
  (default info) plus a one-shot boot log of the effective level.
  Cross-link with ch04 §2 capture and ch05 §1 G11 grep is consistent.

## Findings

No new P0/P1 from R3 in round 2.

Round-1 P2-1 (`fd_warn_threshold` for >50 SSE sockets) was a P2 in
round 1; not re-raised. v0.3 does not target stress-load reliability;
v0.4 hardening is the right home.

### Notes (not P0/P1)

- The "Spawn-failure error handling" subsection inside the
  ready-signal contract block at §3 says "NOT retrying spawnDaemon
  (that retry is owned by §3 'Spawn failure path' below and applies to
  the port-collision case ONLY)." This correctly disambiguates the
  ready-signal contract's no-retry clause (for stdout-EOF / malformed
  PORT / startup-timeout) from the §3 Spawn failure path's single
  retry (for port collision). A future reader may briefly stumble on
  the in-section back-reference, but the rule is unambiguous; no
  fixer action.
- The §5 `pty:input` token table row carries the parenthetical
  "(silent-drop semantics per R1 baseline-cite above take precedence
  over `no_such_sid` if v0.2 dropped silently)". This is a correct
  encoding of the R1/R3 negotiated outcome (R1 wins on the API shape;
  R3's closed-enum applies when v0.2 already returned a typed error)
  and does not weaken the closed-enum invariant.

## Cross-file findings

None. All R3 round-1 cross-cuts (cold-spawn budget → ch01 + ch05;
SSE dedup → ch04 §4 / ch05 §1; stderr format → ch00 §6 + ch04 §2 +
ch05 §1 G11) are closed and consistent.
