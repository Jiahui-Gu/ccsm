# Review of chapter 00: Overview

Reviewer: R3 (reliability / observability)
Round: r1

## Findings

### P1-1 (must-fix): no failure-mode policy at the spec level for daemon spawn / crash

**Where**: chapter 00, §3 "Iron rules" and §6 "Quality bar".
**Issue**: The iron rules cover transport (no IPC regression), feature drift, skip-zero, and sigkill-reattach, but make no statement about what happens when the daemon itself fails to start, crashes mid-session, or its loopback port collides. Chapter 03 §7 punts "daemon process supervision (auto-restart on crash)" to v0.4. That is reasonable for *auto-restart*, but the spec still owes a one-line v0.3 policy: on `spawnDaemon` failure or mid-session daemon exit, what does the renderer / window do? Hard-crash electron, surface a typed error toast, or grey out the UI?
**Why this is P1**: without a policy, each fixer (PR-3, PR-6) will pick a different behaviour. The ship-gate (G1-G10) does not catch "daemon dies mid-test" because the harness assumes daemon stays up. v0.3 ships with undefined post-crash UX.
**Suggested fix**: add an iron rule §3.7: "Daemon liveness contract: on `spawnDaemon` rejection in `electron/main.ts`, electron MUST hard-exit with non-zero code and log the failure to stderr in the documented format (chapter 03 §6). On daemon process exit AFTER window creation, electron MUST surface a renderer toast via the existing zustand error slice and disable pty/data RPCs until app restart. Auto-restart is v0.4." Cross-link from chapter 03 §7.

### P1-2 (must-fix): observability format for stderr / log surface is unspecified

**Where**: chapter 00, §6 "Quality bar / acceptance criteria".
**Issue**: Acceptance is purely "tests green". There is no requirement that daemon-side or electron-main-side errors are debuggable post-mortem (e.g. structured stderr lines, LOG_LEVEL env var, or even consistent prefix). When CI flakes, the only signal today is `/tmp/t574-e2e.log` interleaved Playwright output; daemon stderr is not captured by harness-runner per the chapters as written.
**Why this is P1**: the v0.3 repair WILL flake in CI at least once (Risk-1 in chapter 05 explicitly anticipates this). Without a stderr capture/format contract, a single flake will cost hours of bisection.
**Suggested fix**: add §6 bullet 6: "Every daemon stderr line MUST be prefixed with `[ccsmd] <ISO-8601> <level> <category>:` (level ∈ debug/info/warn/error). Electron main MUST forward daemon stderr to its own stderr unmodified. Harness-runner MUST capture both streams to per-case files under `tmp/e2e-logs/<case>.{electron,daemon}.log`." Detailed contract owned by chapter 03 §6.

### P2-1 (nice-to-have): §1 narrative cites `electron/main.ts:171` calling `spawnDaemon` fire-and-forget; chapter 03 §3 mandates Option C (await)

**Where**: chapter 00, §1 (no specific line — it's an implicit narrative statement); chapter 03 §3 changes the contract.
**Issue**: Once chapter 03 lands, §1's "wave-2 cutover left half-wired" narrative will read confusingly — the fire-and-forget is no longer the post-spec state. Minor but a future reader of the spec-as-shipped will be confused.
**Why this is P2**: pure clarity, not a reliability bug.
**Suggested fix**: add a parenthetical to §1 item 3: "(post-repair behaviour defined in [03-ptyhost-wiring](./03-ptyhost-wiring.md) §3 — `spawnDaemon` becomes awaited)".

## Cross-file findings

- P1-1 is cross-cutting: the rule lives in chapter 00 but the implementation contract lands in chapter 03 §3 (spawn failure path) and chapter 03 §6 (renderer error surface — currently a single sentence; needs the typed-error part). One fixer should own both edits to keep the contract self-consistent.
- P1-2 is cross-cutting: chapter 00 (acceptance), chapter 03 (format), chapter 04 (harness-runner capture). Single fixer.
