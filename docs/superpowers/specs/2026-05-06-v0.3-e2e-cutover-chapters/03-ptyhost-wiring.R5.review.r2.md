# Review of chapter 03: ptyHost wiring

Reviewer: R5 (Testability)
Round: 2

## Round-1 closures

- **R1 P0-1 (TerminalPane has no UT — `host` flag e2e-only)** — CLOSED. §1 now carries the "MUST UT — TerminalPane unconditional host (R5 testability lever)" subsection (lines 82-112) with three explicit cases (`claudeAvailable: false` / `crashed` / `idle`), each asserting `getByTestId('terminal-host')` resolves with `data-sid`. Path is `tests/components/TerminalPane.test.tsx` **NEW** with the exact note "file does NOT exist at HEAD `5d0c5375`; verified `ls tests/components/` and `ls tests/terminal/`. The conventional path matches `src/components/TerminalPane.tsx`, NOT `tests/terminal/`." — both r1 axes (path correctness AND NEW-not-EXTEND) fixed. Cross-link to ch05 PR-4 carried (PR-4 acceptance now lists the same 3 cases, line 195-204). Verified at HEAD: `tests/components/TerminalPane.test.tsx` does NOT exist — NEW status correct.
- **R1 P0-2 (Option C lacks ready-signal contract for `spawnDaemon`)** — CLOSED. §3 now has, in order:
  - "`spawnDaemon()` ready signal (MUST, R5 testability)" subsection (lines 204-226) pinning the `^PORT=(\d+)$` regex, port range `[1024, 65535]`, typed-Error rejection codes (`spawn_failed | malformed_port | stdout_eof | child_exit_before_port | startup_timeout`).
  - "10s startup timeout (MUST, R5 testability)" subsection (lines 228-239) pinning the 10s wall-clock bound and the timer-start point.
  - "Spawn-failure error handling (MUST)" subsection (lines 241-256) pinning `dialog.showErrorBox` + `app.exit(<non-zero>)` + no auto-restart.
  - "MUST UT — `electron/__tests__/daemon-spawner.test.ts` (R5 testability)" subsection (lines 258-279) with exactly four cases: PORT happy / malformed / EOF / 10s timeout, each asserting typed `code`, `vi.useFakeTimers()` for the timeout. File explicitly **NEW** with HEAD verification.
  Reorder of "Required contract" → ready-signal → 10s timeout → error-handling → UT → Option C decision is exactly the r1-recommended shape; the chapter now reads top-to-bottom self-contained. Verified at HEAD: `electron/__tests__/daemon-spawner.test.ts` does NOT exist — NEW status correct.
- **R1 P1-1 (three RPCs Connect-roundtrip is hand-waved)** — CLOSED. §5 now has a "Connect-roundtrip harness cases (Set A — three dedicated cases per RPC)" subsection (lines 538-558) with a table of three Set A cases: `pty-input-roundtrip`, `pty-resize-roundtrip`, `pty-claude-available-roundtrip`. The text explicitly supersedes the per-RPC "Connect-roundtrip" lines and rejects "indirect coverage" (`'terminal-pane-mounted` indirectly covers' is INSUFFICIENT). r1 picked option (a) Strict; the spec landed exactly that.
- **R1 P1-2 (G-1..G-4 lack mapping to UT cases; G-4 has no UT)** — CLOSED. §2 now has a 5th guarantee G-5 (lines 134-148) "reconnect dedup contract" pinning `seq` monotonicity, `snapshotLastSeq`, 64 KiB renderer queue cap, and `daemon_unavailable` overflow surface. §2 UT requirement (lines 163-181) now adds the 4th case "subscriber close + reconnect (per G-5) → the new EventSource receives ONLY events with `seq > snapshotLastSeq`; the renderer MUST observe zero replay of pre-close events. UT asserts the filtered event set equals the post-reconnect emission set exactly (no replay, no drop of post-reconnect events). Queued input issued during the reconnect window MUST be observed by the pty fake exactly once after the new EventSource opens, in arrival order." G-4 (the r1 gap) is now G-5-with-teeth + UT-pinned.
- **R1 P1-3 (sigkill-reattach TTL boundary UTs)** — CLOSED VIA DEFER (manager round-1 decision). The 4 boundary UTs are explicitly defer-to-v0.4 in §7 F-5 (lines 658-661) with the v0.4 owner placeholder. The r1 ask is now correctly out-of-scope for v0.3 per the R1-strict-preservation manager call — sigkill v0.3 = restore the v0.2 attach-replay path only, no new TTL/cap/eviction semantics. Not raising.
- **R1 P2-1 (error tokens lack a registry)** — CLOSED. §5 now has "Error-token enum (closed set, per-RPC subset)" subsection (lines 567-594) with a closed-enum table (`no_such_sid` / `pty_dead` / `bad_request` / `spawn_failed` / `daemon_unavailable` / `internal`) plus a per-RPC emit-subset table. Reviewers grep against the table; new tokens are breaking-change spec edits. Exactly the registry r1 asked for.

## Findings

No P0/P1 from R5 testability angle. ch03 absorbed the heaviest round-1 R5 load (4 P0/P1) and landed all of them with concrete UT files, typed-error contracts, and signal-vs-poll discipline. Verified path-existence claims at HEAD match the spec's NEW/EXTEND annotations.

## Cross-file findings

None new. r1 cross-cuts:
- P0-1 (TerminalPane UT) → cross-cut to ch05 PR-4 acceptance — landed (ch05 §3 PR-4 lists same 3 UT cases + correct path).
- P0-2 (Option C ready signal + timeout + UT) → cross-cut to ch05 PR-3 acceptance — landed (ch05 PR-3 lists the same 4 UT cases + cold-launch budget table).
- P1-1 (three RPC dedicated cases) → cross-cut to ch04 §4 — table at ch04 §4 carries `daemon-port-ready-before-render` / `sigkill-reattach` / `loadstate-roundtrip` (the three Set A RPC cases live in ch03 §5 directly rather than re-tabulated in ch04 §4, which is fine — they are harness cases pinned by their owning chapter).

## Verdict

**CLEAN** for ch03.
