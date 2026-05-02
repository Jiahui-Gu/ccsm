# R0 (zero-rework) review of 15-zero-rework-audit.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 Audit row "[09 §1]" treats `crash_log.owner_id` add-with-NULL as additive — actually a semantic shift / privacy regression

**Location**: `15-zero-rework-audit.md` §1 row "§10 (crash collector)" and §2 row "[05 §5]"
**Issue**: The audit verdicts both rows as "**additive**" because the schema add is mechanically a new column with a NULL default. But the **operational** consequence is that v0.3-era rows (all attributable to a single `local-user`) become NULL = "global" after migration, making them visible to v0.4 cf-access principals. That is a semantic shift of the existing `GetCrashLog` RPC (returns different data for the same caller depending on daemon version). The audit's mechanical "additive" verdict misses the semantic-shift angle the brief requires reviewers to catch.
**Why P0**: The audit chapter is THE gate per its own §5; if it greenlights this, it greenlights an UNACCEPTABLE pattern. Same root cause as `07-data-and-state.R0.review.md` P0.1, `09-crash-collector.R0.review.md` P0.1, `05-session-and-principal.R0.review.md` P0.1.
**Suggested fix**: Revise these rows to "**unacceptable** unless `owner_id` is shipped in v0.3 as `NOT NULL`". Update the audit verdict explicitly. Cross-link to chapter 07 §3 where the `001_initial.sql` ships the column.

### P0.2 Audit row "[05 §5]" `settings_per_principal` add-as-new-table introduces precedence rule that didn't exist in v0.3 — semantic shift

**Location**: `15-zero-rework-audit.md` §2 row "[05 §5]" ("crash_log gains `owner_id`; settings gains per-principal table — existing rows valid as global")
**Issue**: Adding a `settings_per_principal` table beside the existing `settings` table requires a new precedence rule ("per-principal overrides global; missing → global"). In v0.3 the rule does not exist — `GetSettings` returns the (only) `settings` table contents verbatim. Per-principal lookup in v0.4 changes `GetSettingsResponse` payload semantics for the same caller depending on whether a per-principal entry exists. Brief §6: no semantic changes on existing fields.
**Why P0**: Same UNACCEPTABLE pattern as P0.1; audit row's "additive" verdict is wrong.
**Suggested fix**: Update the row to require v0.3 to ship the `(scope, key, value)` shape from day one (per `07-data-and-state.R0.review.md` P0.2). Audit verdict becomes "**additive** because v0.3 already accepts a `scope` parameter and v0.4 adds new scope values."

### P0.3 Forbidden-patterns list (§3) does not forbid v0.4 from broadening `WatchSessions` semantic to cross-principal

**Location**: `15-zero-rework-audit.md` §3 (12-item forbidden list)
**Issue**: The list correctly forbids reshaping proto, reusing field numbers, modifying migration files, etc. It does NOT forbid changing the *behavior* of `WatchSessions` (and similar handlers) when v0.4 introduces new principal kinds. A v0.4 contributor could "improve" `WatchSessions` to switch on `ctx.principal.kind` and emit cross-principal events for admin principals — semantic change of an existing RPC's behavior. The mechanical forbidden-pattern list misses behavioral additivity.
**Why P0**: Audit chapter is supposed to be exhaustive; the gap here means even a careful v0.4 reviewer following only the §3 checklist would miss this UNACCEPTABLE pattern.
**Suggested fix**: Add to §3:
- "13. Changing the response set of any v0.3 RPC depending on `ctx.principal.kind` (admin, cf-access, etc.) — new behavior MUST go in a new RPC name, not by widening an existing RPC's semantics."
- "14. Adding a precedence rule ('B overrides A') between any v0.3-shipped data store and a v0.4-added one — v0.4 MUST be queried independently, not merged with v0.3 data semantics."

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Sub-decision item 1 (worker_threads) is flagged but the audit's table verdict for `06 §1` is "**none**" — internally inconsistent

**Location**: `15-zero-rework-audit.md` §2 row "[06 §1]" + §4 item 1
**Issue**: §2 verdict for `[06 §1]` (worker_threads choice) says "**none**" — meaning v0.4 needs no change. §4 item 1 acknowledges the trust-domain isolation problem and says "Reviewer should consider mandating `child_process` per session". These are inconsistent: if v0.4 multi-principal needs OS-level isolation, the verdict is NOT "none" — it's "v0.4 reshape required" = UNACCEPTABLE. The audit chapter punts the decision to reviewers without taking a position.
**Why P1**: Audit chapter consistency. See `06-pty-snapshot-delta.R0.review.md` P0.1 for the architectural fix.
**Suggested fix**: Take a position. If the recommendation is to switch to `child_process`, update §2 row to additive (process boundary added). If the recommendation is to keep `worker_threads`, update §2 row to "**unacceptable unless v0.3 ships per-principal helper-process boundary**" and force the chapter 06 fix.

### P1.2 Sub-decision item 2 (SnapshotV1) flagged but §2 row "[06 §2]" verdict is "**additive**" relying on `schema_version=2` future addition

**Location**: `15-zero-rework-audit.md` §2 row "[06 §2]" + §4 item 2
**Issue**: Same shape as P1.1. §2 says "additive: new schemas use schema_version=2+; v1 retained forever". §4 acknowledges the format wasn't brief-locked. The unacknowledged issue (per `06-pty-snapshot-delta.R0.review.md` P0.2): SnapshotV1 is uncompressed and ~7 MB for typical usage, which is network-infeasible for v0.4 web/iOS. Adding `schema_version=2` is mechanically additive but operationally forces dual-encoder paths in the daemon forever.
**Why P1**: Audit verdict "additive" is mechanically true but operationally hides a v0.4 cost the brief wanted reviewers to catch.
**Suggested fix**: Update §2 row to "additive (mechanically); flagged: v0.4 web/iOS will REQUIRE schema_version=2; daemon must serve dual encoders forever — recommend v0.3 ship compression in v1 from day one."

### P1.3 Sub-decision item 9 (renderer transport bridge) is recommended but §2 has no row for it

**Location**: `15-zero-rework-audit.md` §2 (no row); §4 item 9 ("recommended for predictability")
**Issue**: The renderer transport bridge is Electron-internal (per `08-electron-client-migration.R0.review.md` P0.3 it should be unconditional). The audit table doesn't have a row for it, so v0.4 has no documented "this is unchanged" verdict.
**Why P1**: Documentation gap.
**Suggested fix**: Add a §2 row: "[08 §4 / 14 §1.6] Renderer transport bridge in Electron main | unchanged (Electron-only); v0.4 web/iOS use connect-web/connect-swift directly without a bridge | **none**". Add to §3 forbidden-patterns: "v0.4 MUST NOT modify the Electron main-process transport bridge for web/iOS reasons."

### P1.4 §3 forbidden-patterns item 7 ("Renaming `principalKey` format or any of its `kind:identifier` strings") is fine but doesn't cover format ambiguity if `identifier` contains `:`

**Location**: `15-zero-rework-audit.md` §3 item 7
**Issue**: Forbidding rename is good; doesn't address the parsing ambiguity flagged in `05-session-and-principal.R0.review.md` P1.2 (cf-access `sub` may contain colons).
**Why P1**: Documentation tightening.
**Suggested fix**: Update item 7 to: "Renaming `principalKey` format, changing the 'first-colon-is-separator' parse rule, or repurposing existing `kind` values."
