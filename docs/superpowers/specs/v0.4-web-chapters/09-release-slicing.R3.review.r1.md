# Review of chapter 09: Release slicing

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): "Auto-update default OFF for v0.4 if R1 trouble" lacks decision criteria

**Where**: chapter 09 §6 + chapter 10 R1.
**Issue**: §6 says "If serious problems: pause auto-update default-OFF for v0.4; require user-initiated install. Tracked in chapter 09 §6." No definition of "serious problems" — N stuck-upgrade reports? % failure rate? Time-to-recovery threshold? Without criteria, it's a judgment call at release time, and reliability bugs leak.
**Why this is P1**: this is the reliability gate for the whole release. Vague criteria = late slip / unsafe release.
**Suggested fix**: §6 add explicit gate: ">1 stuck-upgrade reproduction in M2 dogfood = pause auto-update; <1 = ship default-ON." If the author is the only dogfood user, the standard is ANY occurrence. Cite the gate explicitly.

### P1-2 (must-fix): Rollback strategy assumes SQLite is "additive only"; not enforced

**Where**: chapter 09 §8 ("Why no 'downgrade to v0.3' rollback path").
**Issue**: "v0.4 changes the SQLite schema only additively (no destructive migrations expected)" — "expected" is hopeful. There's no schema-diff check in CI to confirm v0.4 migrations are pure-additive vs v0.3. A future PR adding a NOT-NULL column or dropping a table breaks the implicit promise silently.
**Why this is P1**: "no rollback path" combined with "actually was destructive" = user data loss when v0.4.x has a critical bug and they need v0.3.
**Suggested fix**: §8 add CI gate: "schema-additive lint" — automated check that v0.4 migrations only ADD tables/columns/indexes, never drop or alter type. Backed by parsing the migration files in `daemon/src/db/migrations/`. Reference in chapter 08 testing.

### P1-3 (must-fix): Dogfood gates cumulative time = ~17 days, but no date budget

**Where**: chapter 09 §1 + §7.
**Issue**: M1 (24h) + M2 (7 days) + M3 (3 days) + M4 (7 days) = 17 days of dogfood serialized. Plus implementation (~110h). At 40h/wk that's ~3wk impl + 2.5wk dogfood = ~5.5wk minimum. No upper bound; if M2 dogfood reveals an issue (per §8 "extend M2 dogfood"), timeline drifts. Not a hard P0 (project_direction_locked says "no active deadline"), but R3 cares because: a stale-mid-flight v0.4 milestone (e.g. M3 done, M4 dogfood lingering for weeks while M3 bugs accumulate uncollected) creates context-loss risk.
**Why this is P1**: liveness/observability of the release pipeline itself. Need a "dogfood is stuck — escalate" signal.
**Suggested fix**: §7 add: "Dogfood gate exceeds 2× planned duration → escalate to user; either ship a hot-fix mid-gate or pause and re-evaluate." Cite explicitly.

### P2-1 (nice-to-have): No M3-internal milestone for "web client error reporting wired"

**Where**: chapter 09 §4 M3 deliverables.
**Issue**: Cross-ref chapter 04 P1-1 (web error reporting). M3 deliverables include the web build but not "error reporting RPC + log path." Without this, M3 dogfood gate (3-day) has no telemetry to evaluate.
**Suggested fix**: Add deliverable #9 to M3: "Web error reporting RPC `ReportClientError`, daemon-side log file `~/.ccsm/web-client-errors.log`, hidden-settings 'copy diagnostics' button."

### P2-2 (nice-to-have): "Auto-update rc1 → rc2 force-update test" missing in M2 done definition

**Where**: chapter 09 §3 M2 done definition.
**Issue**: Cross-ref chapter 07 P1-3. M2 dogfood is the only window where the upgrade path gets exercised, but it's not in the done-definition checklist.
**Suggested fix**: §3 add to done definition: "Force-update from v0.4.0-rc1 to rc2 succeeds; force-rollback from rc2 to rc1 succeeds (manual installer step OK)."

## Cross-file findings (if any)

- **Schema-additive enforcement (P1-2)** ties to chapter 08 testing — needs CI workflow added there too.
- **Auto-update force-test (P2-2)** ties to chapter 07 P1-3.
