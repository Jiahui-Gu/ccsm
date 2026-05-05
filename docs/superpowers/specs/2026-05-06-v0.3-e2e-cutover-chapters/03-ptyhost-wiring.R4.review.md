# Review of chapter 03: ptyHost wiring

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): Option C `await spawnDaemon` adds unmeasured cold-launch latency to the user-visible window-show

**Where**: chapter 03, §3 "Daemon-port readiness (HP-3)" → "Decision"
(lines 173-180). The decision says "the window-show latency penalty
is sub-second on every measured platform" but no number is recorded
anywhere in the spec.
**Issue**: Option C synchronously sequences daemon-spawn AHEAD of
`createWindow()`. The user's "click → window appears" delay grows by
the full daemon boot time (fork node child + auto-registry walk over
all `daemon/api/*.js` + bind loopback + `PORT=` print). On Windows in
particular, node spawn + module-registry walk can be 300-800ms cold,
and the spec records no measurement to justify the "sub-second"
claim.
**Why this is P1**: this is THE single user-perceptible perf change in
v0.3. Iron rule §3.1 (zero e2e skip) is well-protected, but there's no
analogous gate on first-paint regression. Without a number, PR-3 ships
"trust me, it's fast" and we discover only via interactive use whether
the spec made the wrong call. Not P0 because it's measurable during
PR-3 implementation rather than blocking spec merge.
**Suggested fix**: chapter 03 §3 "Decision" must record:
1. Measured cold-boot daemon-spawn latency on dev's primary box (an
   actual ms number, captured by adding a `console.time` around
   `spawnDaemon()` once and pasting the result).
2. A budget: "Option C adds ≤500ms to first-paint vs. pre-cutover
   baseline; if a future profile shows >500ms, fall back to Option B".
3. A rollback trigger: a one-line acceptance step in PR-3 ("captured
   first-paint delta is <budget").
This re-uses the 500ms number already mentioned by chapter 05 §7
Risk-1 — the two should be cross-linked.

### P1-2 (must-fix): SSE `pty:data` pipe lacks any latency / throughput target

**Where**: chapter 03, §2 "SSE event delivery" (lines 69-101).
**Issue**: pty data is the highest-frequency event the renderer
processes. A `claude` session producing token-by-token output, or any
TUI emitting a redraw, generates dozens of `pty:data` events per
second; xterm itself can drive ~60fps render. The wave-2 path now is
`pty.onData → daemon SSE multiplexer → JSON.stringify (with base64?)
→ HTTP chunked write → preload EventSource → JSON.parse → renderer
write`. None of that is benchmarked, and §2's four "guarantees"
(G-1..G-4) are all correctness, none are latency / throughput. Chapter
00 §2 explicitly defers benching to Set B. That's fine for measurement,
but design should AT LEAST own a target so we know what Set B is
verifying.
**Why this is P1**: under common use (one interactive `claude` session)
loopback HTTP + JSON+SSE is almost certainly fine. But the spec gives
no per-event budget (e.g. "≤5ms producer-to-paint p99 on dev box") so
when a future flake "claude output feels laggy" lands, there's no
contract to debug against. Not P0 because typical sub-bandwidth claude
output won't saturate; P1 because shipping without a target is a
known-hole in the v0.3 design.
**Suggested fix**: chapter 03 §2 add a §2.x "Latency / throughput
targets":
- target p99 producer→renderer-paint latency ≤ 20ms on dev's primary
  box for ≤5 concurrent sessions
- per-sid sustained throughput ≥ 1 MiB/s (xterm consumer is the cap,
  not the pipe)
- one Set B harness probe drives `yes | head -c 1MB` and asserts the
  draining time
The numbers can be ballpark; what matters is having them written.

### P1-3 (must-fix): `getBufferSnapshot` size cap unspecified for sigkill-reattach

**Where**: chapter 03, §4 "sigkill-reattach (HP-8)" → "Implementation
responsibilities" (lines 218-225).
**Issue**: the daemon "MUST retain the pre-kill buffer for the sid until
either (a) detach + 60s TTL or (b) fresh spawn". No upper bound on the
buffer SIZE is specified. A long-running pty (hours of `claude` output)
can produce many MiB of scrollback before being SIGKILLed; if the
daemon retains the full buffer for 60s × N dead sids, RSS grows
unbounded. Also, sending a multi-MiB snapshot in the `attach` response
blocks the renderer paint and balloons memory both sides.
**Why this is P1**: directly the sort of "common ≤10-session usage
trips a resource cap" risk R4 is meant to catch. v0.3 single-user can
realistically have a session with 10+ MiB of scrollback (typical
xterm scrollback default is 1000 lines but daemon-side may not bound
it).
**Suggested fix**: chapter 03 §4 add: "the snapshot returned by
`attach` after sigkill MUST be capped at the last N KiB of pty output
(suggest 256 KiB ≈ ~2000 lines); older content is truncated with a
single `[…snipped <N> bytes…]` marker. The cap matches xterm's
default scrollback so the user-visible loss is none. Daemon-side
`dataFanout.ts` ring buffer already implements this — verify the cap
size and document it here." Also add a UT in
`daemon/ptyHost/__tests__/dataFanout.test.ts` asserting the cap holds
under a 10 MiB write.

### P2-1 (nice-to-have): Preload `EventSource` per sid is not justified vs. multiplexing

**Where**: chapter 03, §7 "Out-of-scope (deferred)" line 313
("Multiplexing all sids onto a single SSE stream: not blocking; current
per-sid model is simple and the bug isn't here").
**Issue**: per-sid `EventSource` means N TCP connections + N HTTP
parsers for N open sessions. On v0.3 single-user with ≤10 sessions
that's 10 loopback sockets — fine. The "out-of-scope" framing is right
for v0.3, but the chapter doesn't record the threshold beyond which
multiplexing becomes mandatory. A future fixer adding "session-list
preview pty" or similar could double session count without realising
they crossed a budget.
**Why this is P2**: not blocking v0.3; just preserving the design
rationale for the next person.
**Suggested fix**: §7 add half a sentence: "current per-sid model
expected to scale to ≤20 concurrent EventSources; beyond that,
multiplex; revisit in v0.4".

### P2-2 (nice-to-have): No guidance on `sessionTitles` / session-list update transport (poll vs event)

**Where**: chapter 03 (entire chapter — sessionTitles is wave-2-A but
not addressed here).
**Issue**: chapter 01 lists `sessionTitles` as wave-2 hot path
(HP-1..HP-13 not explicit on it, but the overview mentions wave-2-A
moved it to daemon). If the renderer pulls the title list via polling
`window.ccsmCore.listSessionTitles()` rather than subscribing to an
event, an N-session UI does N HTTP calls per refresh. The spec doesn't
say which model is in use post-cutover.
**Why this is P2**: a potential N+1 at large session counts but at
v0.3 single-user ≤10 sessions even polling once a second is trivial.
Worth a one-line confirmation but not blocking.
**Suggested fix**: chapter 03 add a §6 (between Error surface and
Out-of-scope) or chapter 02 §1 add a row clarifying: "session-title
list is event-driven (`SSE /api/sessionTitles/events`), NOT polled —
verify in `electron/preload/bridges/ccsmCore.ts`. If post-cutover
the renderer polls, file follow-up." If the answer is "polled in
v0.3, fine for ≤10 sessions, plan event-driven for v0.4", say that.

## Cross-file findings

P1-1 (cold-launch budget) spans:
- chapter 01 §HP-3 (problem statement) — see `01-cutover-audit.R4.review.md` P1-1
- chapter 03 §3 (decision) — this file P1-1
- chapter 05 §7 Risk-1 (capture point) — see `05-release-slicing-and-dag.R4.review.md`
Manager assign one fixer to land the number consistently across all three.

P1-3 (snapshot cap) spans chapter 03 §4 (contract) and the
implementation file `daemon/ptyHost/dataFanout.ts` (verification);
co-located in chapter 03 by one fixer.
