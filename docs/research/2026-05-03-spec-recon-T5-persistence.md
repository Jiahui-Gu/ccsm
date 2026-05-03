# T5.x Persistence + Crash — Deep Spec Reconciliation (Sub-Audit C)

**Date**: 2026-05-03
**Author**: research agent (pool-12, Task #203)
**Scope**: Deep audit of every T5.x merged task vs `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` ch07 (Data and State) + ch09 (Crash Collector). Targets **gaps the parent baseline (`research/2026-05-03-spec-reconciliation` — `docs/research/2026-05-03-v03-spec-reconciliation-audit.md`) painted as ALIGNED but that don't actually hold under deeper inspection**.
**Mode**: READ-ONLY. No production code changes.

The parent baseline tagged 11 of 13 T5.x rows ALIGNED. This sub-audit re-checks each row against the literal spec text (ch07 §1–§8, ch09 §1–§7) and the actual implementation, and finds **8 additional drifts** the parent missed. Two are CRITICAL ship-risk; the rest are latent but real.

---

## Severity legend

- **ALIGNED** — implementation matches spec literally.
- **MINOR DRIFT** — naming / path / decoration; no behavior delta.
- **DRIFT** — real behavior or design difference; ship-acceptable but a divergence.
- **CRITICAL DRIFT** — violates a spec invariant or ship-gate; should not ship as-is.
- **SPEC SELF-CONTRADICTION** — two chapters disagree; implementation matches one but not the other.

---

## New drifts found by this sub-audit

### D1. CRITICAL DRIFT — `state/` segment missing from DB and crash-raw paths

**Spec ref**: ch07 §2 layout table — column "DB path" shows `state\ccsm.db` (win), `state/ccsm.db` (mac, linux). Column "Crash log file (raw)" shows `state\crash-raw.ndjson` / `state/crash-raw.ndjson`. The descriptor file column DOES NOT use `state/` (it lives directly under root). The spec table's DB path is RELATIVE TO ROOT — i.e., the on-disk path is `<root>/state/ccsm.db`.

**Evidence — code**: `packages/daemon/src/state-dir/paths.ts:80-86`:

```ts
return Object.freeze({
  root,
  descriptor: join(root, 'listener-a.json'),
  descriptorsDir: join(root, 'descriptors'),
  db: join(root, 'ccsm.db'),                  // spec says <root>/state/ccsm.db
  crashRaw: join(root, 'crash-raw.ndjson'),   // spec says <root>/state/crash-raw.ndjson
});
```

**Evidence — tests freeze the drift**: `packages/daemon/test/state-dir/paths.spec.ts:62-103` asserts `db: 'C:\\ProgramData\\ccsm\\ccsm.db'` (no `state\` segment) on every OS branch. T10.7 / Task #122 named these tests as the layout freeze, and they actively encode the `state/`-less layout.

**What the parent baseline said**: T5.3 row marked **ALIGNED — fix already merged** citing PR #936. PR #936 only unified `defaultStateDir()` vs `statePaths()` for the `/state` segment ownership *within env.ts/state-dir*; both ended up with NO `state/` segment, which is the opposite of what spec §2 says.

**Spec ch10 §5 corroborates**: Linux systemd unit uses `StateDirectory=ccsm` → `/var/lib/ccsm` is the StateDirectory. The DB inside it goes at `<StateDirectory>/state/ccsm.db` per ch07 §2. systemd does NOT auto-create `<StateDirectory>/state/` — the daemon would need to mkdir it. Today no code does, because today the DB lives directly under the root.

**Impact**: ship-gate (d) inspection. Anyone writing the v0.3 installer to grant DACL on `<root>/state/` per §2 would diverge from the actual on-disk layout. Also affects backup tooling: `Settings → Backup → Export` per ch07 §6 must operate on the spec-correct path.

**Fix size**: ~20 lines in `state-dir/paths.ts` + matching tests. Is this drift the spec being wrong (table column uninterpretable) or the code being wrong? Either way the spec table and the code DO disagree literally; reviewers cannot grep "ccsm.db" against ch07 §2. **Decision-required: amend the spec table OR fix the code.**

**Already fixed?** No.

---

### D2. CRITICAL DRIFT — capture-source orchestrator never installed at boot

**Spec ref**: ch09 §1 first sentence: "The daemon registers crash capture handlers at boot, **before any RPC handler runs**." Spec ch09 §6.2: `CAPTURE_SOURCES` table-driven contract; `installCaptureSources(ctx)` is the orchestrator.

**Evidence**: `packages/daemon/src/crash/sources.ts` exports `CAPTURE_SOURCES` and the `installCaptureSources` orchestrator (516 lines, fully implemented). `packages/daemon/src/index.ts` (the entrypoint) does **NOT import or call** anything from `./crash/sources.js` (verified via grep — zero hits for `installCaptureSources` / `crash/sources` outside the module's own files and tests).

```text
$ grep -nE 'installCaptureSources|crash/sources' packages/daemon/src/index.ts
(no output)
```

**Impact**: Every named capture source listed in spec ch09 §1 (`uncaughtException`, `unhandledRejection`, `claude_exit`, `claude_signal`, `claude_spawn`, `pty_eof`, `session_restore`, `sqlite_open`, `sqlite_op`, `worker_exit`, `listener_bind`, `migration`, `watchdog_miss`) is DEAD CODE in production. A real `uncaughtException` in the daemon process today exits Node without writing a `crash_log` row. ship-gate (b) "daemon survives + user told" cannot be honored.

**Why parent baseline missed it**: row #62 T5.11 was marked ALIGNED on the basis that `packages/daemon/src/crash/sources.ts` exists and its tests pass. Existence + unit-test passes ≠ wired into entrypoint. Parent baseline didn't grep `index.ts`.

**Already fixed?** No.

---

### D3. DRIFT — `replayCrashRawOnBoot` never invoked from entrypoint

**Spec ref**: ch07 §6 step 6 — after fresh DB open + `001_initial.sql`: "**Replay** any NDJSON lines from `state/crash-raw.ndjson` into the new `crash_log` table". ch09 §2 corroborates: "On next successful daemon boot, the daemon scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file."

**Evidence**: `packages/daemon/src/crash/raw-appender.ts:204` exports `replayCrashRawOnBoot({ path, db })` (~110 lines, implemented + tested in `test/crash/crash-raw-recovery.spec.ts`). Entrypoint `packages/daemon/src/index.ts` does NOT call it (`grep -n 'replay' index.ts` returns one comment about `crash-raw filenames`, no call site).

**Impact**: every NDJSON line written by the corrupt-DB recovery path (`source: 'sqlite_corruption_recovered'`) accumulates forever in `crash-raw.ndjson` and never lands in the queryable `crash_log` table. Settings UI "Recent crashes" table will never show recovery events. Bigger picture: the replay-on-boot is the entire reason the NDJSON sidecar exists per ch07 §6 ("ensures fatal events that prevented SQLite writes still surface to the user post-recovery") — that surface is silently disconnected.

**Why parent baseline missed it**: row #59 T5.10 marked ALIGNED on PR #909 + PR #944 because the appender + replay function exist and Windows CI flake on the SIGKILL replay test was fixed. Function existence ≠ wiring.

**Already fixed?** No.

---

### D4. SPEC SELF-CONTRADICTION + DRIFT — replay strategy: truncate vs offset-sidecar

**Spec ref ch07 §6 step 6**: "leave the NDJSON file in place (it's append-only; the daemon tracks a `crash_raw_offset` in a sidecar `state/crash-raw.offset` file to avoid re-replaying on restart)".

**Spec ref ch09 §2**: "imports any entries not already in `crash_log` (by id), then **truncates the file**".

These contradict. The implementation (`raw-appender.ts:303` `truncateSync(path, 0)`) follows ch09 §2 (truncate strategy), not ch07 §6 (offset-sidecar strategy). No `crash-raw.offset` sidecar code exists anywhere (`grep -r crash_raw_offset` → only finds comments referencing the spec phrase).

**Why this matters beyond style**: the offset-sidecar pattern lets the file remain a forensic append-only log across daemon boots. The truncate strategy means once replay happens, the historical NDJSON is gone — only the SQLite copy survives. ch07 §6 explicitly framed the NDJSON as a power-loss-survivor; truncating it eliminates that property.

**Decision**: spec needs to pick one; implementation needs to track. Recommended: truncate (ch09 §2) is simpler and matches code; amend ch07 §6 to drop the `crash_raw_offset` paragraph. Or: keep ch07 §6 forensic intent and add the offset sidecar.

**Already fixed?** No.

---

### D5. DRIFT — `WriteCoalescer` never instantiated in production

**Spec ref**: ch07 §5 — pty-host workers `postMessage` deltas to main; main thread enqueues into per-session coalescer; 16 ms tick + IMMEDIATE txn. The coalescer is the single chokepoint guarding ALL pty_delta / pty_snapshot writes.

**Evidence**: `packages/daemon/src/sqlite/coalescer.ts` — full implementation (Task #61 / #184 fix), 545 lines, all `WriteCoalescer` invariants under test. **But**: only the test file `test/sqlite/coalescer.spec.ts` instantiates it. Zero production-code call sites:

```text
$ grep -rn 'new WriteCoalescer' packages/daemon/src
(only test files)
```

**Why this matters**: T5.5 and the entire ch07 §5 write-coalescing layer is an ungrounded promise. Once T6.x pty-host wiring lands, integration teams will need to choose where to construct the coalescer, who owns its `db` handle (the entrypoint already opens one via `openDatabase` and passes to `runMigrations` + `CrashPruner`), and how `destroy()` is sequenced into shutdown. None of this glue exists.

**Acceptable for v0.3 ship?** Marginal — pty-host integration (T6.x) hasn't shipped yet; the coalescer is dormant because its consumer doesn't exist. **But**: the daemon today has no path through which a `pty_delta` or `pty_snapshot` row is ever written, which means the snapshot-restore loop (ch05 §7 + ch06) is non-functional end-to-end.

**Already fixed?** No.

---

### D6. DRIFT — coalescer disk-class failure does NOT write `crash_log` rows

**Spec ref**: ch07 §5 "Failure handling (FOREVER-STABLE)": "On `SQLITE_FULL` / `SQLITE_IOERR` / `SQLITE_READONLY` ... **the daemon writes a `crash_log` row** (`source = "sqlite_write_failure"`, `summary` includes the error code, the table name, and the session_id if applicable)". Snapshot path: `source = "pty_snapshot_write"`. Queue overflow: `source = "sqlite_queue_overflow"`.

**Evidence**: `packages/daemon/src/sqlite/coalescer.ts:184-190` emits a `'write-failed'` EventEmitter event and a `'session-degraded'` event but does NOT write to `crash_log`. Comments in the file (lines 176-180, 28-30, 237-240) hand the responsibility off to "the PtyService Connect handler (T4.x)" / "the pty-host bridge". No T4.x code does this today; `grep -r 'sqlite_write_failure\|sqlite_queue_overflow\|pty_snapshot_write' packages/daemon` → 2 hits, both inside `coalescer.ts` comments.

**Spec invariant violated**: the spec lists these as FOREVER-STABLE failure-handling rows. The coalescer being decoupled from `crash_log` writing is fine *in principle*, but the wiring **doesn't exist anywhere**, so today the spec invariant is vacuous.

**Spec ch07 §5 also locks**: "after the cool-down period (60 s) expires and a probe write succeeds" — the probe-write logic for restoring from DEGRADED is not implemented. `recordSuccess` in coalescer.ts:480 flips back to healthy on the next regular write, not after a 60 s cool-down + probe.

**Already fixed?** No.

---

### D7. DRIFT — SQLite settings consumers (`sqlite_synchronous`, `wal_autocheckpoint_pages`) not implemented

**Spec ref**: ch07 §3 Settings table — three storage-layer settings keys are FOREVER-STABLE in v0.3:

| Key | Default | Effect |
| --- | --- | --- |
| `sqlite_synchronous` | `"NORMAL"` | Applied as `PRAGMA synchronous = <value>` at boot |
| `wal_autocheckpoint_pages` | `1000` | Applied as `PRAGMA wal_autocheckpoint = <value>` at boot |
| `pty_snapshot_compression_codec` | `1` | zstd vs gzip |

Spec literally says "Daemon rejects any other value at the `UpdateSettings` RPC layer (ch04 §6) with `INVALID_ARGUMENT`."

**Evidence**: `packages/daemon/src/db/sqlite.ts:42-61` hardcodes `synchronous: 'NORMAL'` and `wal_autocheckpoint: 1000` as compile-time constants. No code path reads `Settings.sqlite_synchronous` from the `settings` table at boot. No `UpdateSettings` RPC validation rejects bad values (SettingsService is registered as `{}` stub in `rpc/router.ts`).

**Test inventory**: ch07 §8 mandates `test/integration/db/sqlite-synchronous-config.spec.ts` (set Settings.sqlite_synchronous = "FULL"; restart; assert PRAGMA synchronous returns 2; reject invalid value) — file does not exist.

**Already fixed?** No.

---

### D8. DRIFT — ch07 §8 mandated test inventory: 6 of 7 specs missing

Spec ch07 §8 explicitly lists 7 named test files that "MUST exist and pass in CI before v0.3 ship". Status:

| Spec file path | Status |
| --- | --- |
| `test/integration/db/migration-lock.spec.ts` | EXISTS at adjacent path `test/db/migration-lock.spec.ts` (MINOR — wrong dir) |
| `test/integration/db/integrity-check-recovery.spec.ts` | MISSING |
| `test/integration/db/wal-discipline.spec.ts` | MISSING |
| `test/integration/db/write-coalescer-overflow.spec.ts` | MISSING |
| `test/integration/db/disk-full-degraded.spec.ts` | MISSING |
| `test/integration/db/sqlite-synchronous-config.spec.ts` | MISSING (D7 dep) |
| `test/integration/db/cwd-state-osc7.spec.ts` | MISSING |

There ARE near-equivalents elsewhere (e.g., `src/db/__tests__/recovery.spec.ts` covers the integrity-check happy path, `src/db/__tests__/sqlite.spec.ts` exercises BOOT_PRAGMAs), but none are at the paths spec §8 names, none cover the integration scenarios (sustained 10 MiB/s + WAL cap, tmpfs disk-full + 3-strike DEGRADED, OSC 7 cwd update + restart restore), and ship-gate verifiability per spec §8 says "the following spec files MUST exist".

**Why parent baseline missed it**: parent rows checked individual T5 PRs against task-level summaries (e.g., "T5.5 → coalescer.ts exists"). Spec §8 is a chapter-level *test inventory contract* the parent didn't cross-check.

**Already fixed?** No.

---

### D9. DRIFT — `tools/check-migration-locks.sh` exists but never runs in CI

**Spec ref**: ch07 §4 step 2 — "the script `tools/check-migration-locks.sh` (run in CI on every PR after the v0.3 tag exists)".

**Evidence**: `tools/check-migration-locks.sh` exists (171 lines, fully implemented, handles pre-tag no-op + GH release body fetch + sha compare + locked.ts cross-check). Zero hits in `.github/workflows/`:

```text
$ grep -rn 'check-migration-locks' .github
(no output)
```

**Pre-tag impact**: zero (script no-ops). **Post-tag impact**: any future PR editing `001_initial.sql` would not be caught by CI. Combined with the runtime self-check in `packages/daemon/src/db/locked.ts` the daemon still rejects mismatched bundled migrations at boot — so production is safe — but the spec's "CI-enforced" framing is unmet.

**Note**: this drift compounds with the parent's CRITICAL #1 (T0.8 ci.yml monolithic). PR #906 (the ci.yml-fix) would be the natural place to wire `check-migration-locks.sh` in.

**Already fixed?** No.

---

### D10. DRIFT — spec §3 `pty_snapshot.schema_version` actually unused; coalescer hardcodes `schemaVersion`

**Spec ref ch07 §3**: `pty_snapshot.schema_version INTEGER NOT NULL` is in the v0.3 frozen schema baseline.

**Evidence**: `packages/daemon/src/sqlite/coalescer.ts:107` accepts `schemaVersion: number` on the snapshot write API; line 274 inserts it. But: no consumer of pty_snapshot reads back schema_version (no T6.x snapshot-restore reader exists). The pty-host worker → main `postMessage` payload → coalescer pipeline that supplies `schemaVersion` is also missing (D5). So the column lands at v0.3 ship with no producer and no consumer; the schema slot is reserved for ch06 §2 SnapshotV1 evolution but cannot be exercised.

**Acceptable**: yes — the column IS forever-stable per spec §7 ("**Unchanged**: every column listed in §3"). Reserving an unread column in v0.3 is intentional. Flagged here only for completeness — this is the kind of "field laid down ahead of its consumer" that spec §3 describes as zero-rework prep.

**Already fixed?** N/A — not a drift, just an inert column.

---

### D11. DRIFT — v0.2 → v0.3 user-data migration entirely unimplemented

**Spec ref**: ch07 §4.5 (the entire subsection) — one-shot installer-driven migration: copy v0.2 `ccsm.db` to `<state>/migration-staging/v02-<uid>.db`; first daemon boot post-install detects + migrates sessions table; emits `migration` source crash_log entry; first-launch banner writes `Settings.ui_prefs["migration.v02_to_v03_banner_dismissed"]`.

**Evidence**: `grep -rn 'migration-staging\|v02_to_v03\|v02-<' packages/daemon` returns nothing. No code reads from `<state>/migration-staging/` on boot. No installer task creates the staging file. The first-launch banner UI key has no consumer.

**Why parent baseline missed it**: §4.5 is the only substantive ch07 sub-section without a corresponding T5.NN task ID — there is no `T5.x v0.2 migrator` task to audit, so the row never existed in the parent table. Parent audit was "task-level reconciliation" not "spec-section reconciliation".

**Spec-vs-ship-goal tension**: project_v03_ship_intent ("dogfood, no v0.2 user upgrade pressure") may legitimately deprioritize this. But spec ch07 §4.5 reads as committed FOREVER-STABLE narrative, not "may slip"; reviewers walking ch07 cannot tell which is which.

**Decision-required**: drop §4.5 from spec, OR file a v0.3 task implementing it.

**Already fixed?** No.

---

### D12. MINOR DRIFT — `locked.ts` lives at `db/locked.ts`, spec says `db/migrations/locked.ts`

**Spec ref ch07 §4 step 3**: "the script also enforces that `packages/daemon/src/db/migrations/locked.ts` exports a `MIGRATION_LOCKS` const".

**Evidence**: actual file is `packages/daemon/src/db/locked.ts` (no `migrations/` segment). The CI script `tools/check-migration-locks.sh:33` correctly points at the real location (`packages/daemon/src/db/locked.ts`). Spec text alone is byte-misaligned.

**Impact**: cosmetic only — runtime behavior is correct. Same flavor as the parent baseline's "proto file path drift".

**Already fixed?** Acknowledged in code (script uses real path); spec text not updated.

---

### D13. DRIFT — `CrashService` RPC handlers are `Unimplemented` stubs

**Spec ref ch09 §4**: `CrashService.GetCrashLog(limit, since_unix_ms, owner_filter)`, `WatchCrashLog(owner_filter)`, `GetRawCrashLog()` are explicitly named.

**Evidence**: `packages/daemon/src/rpc/router.ts:53,83` registers `CrashService` with empty `{}` impl — Connect-ES "missing method = Unimplemented" semantics applies. No handler reads `crash_log` table; no streaming wiring; the `crash-raw.ndjson` chunk-streaming RPC does not exist. The Settings UI "Download raw log" + "Recent crashes" table per ch09 §5 has no daemon-side counterpart.

**Why this is a T5.x audit concern (not T4 RPC)**: the T5.x persistence layer writes data into `crash_log` (via the pruner — when capture sources are wired, D2) but **nothing reads it**. The whole T5.12 retention / T5.10 raw-NDJSON / T5.11 capture-handlers chain feeds a sink the user can never query.

**Already fixed?** No — this is genuinely a downstream T-NN-not-yet-shipped, but the parent baseline marking ch09 capture-related rows ALIGNED without flagging the "no read path exists" gap is the omission.

---

### D14. DRIFT — `pty_snapshot` snapshot-write does NOT block delta queue per session

**Spec ref ch07 §5**: "Snapshot writes are out-of-band: own transaction, runs during a quiescent moment (no current delta flush in progress for that session); **blocks deltas for that session for the snapshot duration**."

**Evidence**: `packages/daemon/src/sqlite/coalescer.ts:268-300` — `enqueueSnapshot` runs a synchronous IMMEDIATE transaction, but does NOT pause the per-session delta flush timer or check `state.flushing`. If a delta tick fires concurrently with a snapshot tick on a different sessionId no problem (different IMMEDIATE txns serialize at SQLite level), but on the SAME session there's no explicit "block deltas during snapshot" gate. Today the impl relies on JS single-thread to serialize, which works because both `enqueueSnapshot` and the flush-tick are on main, but the explicit "blocks deltas" invariant from spec is not visibly enforced — the next contributor adding a worker thread for snapshots would silently break the spec.

**Impact**: latent. v0.3 ship is fine because main-thread is the only writer. Forever-stable invariant is implicitly relied on.

**Already fixed?** No (and acceptable to defer).

---

## Existing rows from parent baseline — re-validated

Re-checked the 11 ALIGNED T5.x rows for any new drift the parent missed beyond D1-D14:

| Parent row | Sub-audit verdict | Note |
| --- | --- | --- |
| T5.1 better-sqlite3 wrapper | Parent: ALIGNED. Sub-audit: **DRIFT** per D7 — `sqlite_synchronous` + `wal_autocheckpoint_pages` Settings consumers absent. |
| T5.2 001_initial.sql | ALIGNED — schema matches spec verbatim (sub-audit confirms). |
| T5.3 per-OS state directory | Parent: ALIGNED — fix already merged (PR #936). Sub-audit: **CRITICAL DRIFT** per D1 — `state/` segment missing; PR #936 fixed an internal inconsistency but NOT spec alignment. |
| T5.4 migration runner + lock self-check | Parent: ALIGNED. Sub-audit: **MINOR DRIFT** per D12 (locked.ts path), **DRIFT** per D9 (CI not invoking script). |
| T5.5 write coalescer | Parent: ALIGNED — drift already fixed (PR #932). Sub-audit: **DRIFT** per D5 (never instantiated), **D6** (no crash_log writes on disk-class fail), **D14** (snapshot doesn't block delta queue), **plus** no 60 s cool-down + probe restore. |
| T5.6 WAL discipline | ALIGNED — wrapper checkpoints match spec (sub-audit confirms). |
| T5.7 corrupt-DB recovery | Parent: ALIGNED. Sub-audit: **DRIFT** per D3 (replay-on-boot never invoked), **SPEC SELF-CONTRADICTION** per D4. |
| T5.10 crash-raw.ndjson | Parent: ALIGNED — fix already merged (PR #944). Sub-audit: **DRIFT** per D3 + D4. |
| T5.11 crash capture | Parent: ALIGNED. Sub-audit: **CRITICAL DRIFT** per D2 — `installCaptureSources` never called. |
| T5.12 crash retention pruner | ALIGNED — pruner is wired in entrypoint and runs (sub-audit confirms). |
| T5.13 systemd watchdog | ALIGNED — `startSystemdWatchdog` invoked in `startMainThreadWatchdog()` (sub-audit confirms). |

Outside parent's T5.x table but spec ch07/§09 territory:
- ch07 §4.5 v0.2 → v0.3 migration: not in parent table, **DRIFT** per D11.
- ch07 §8 test inventory: not in parent table, **DRIFT** per D8.
- ch09 §4 RPC surface: parent flagged WatchSessions, did NOT flag CrashService — **DRIFT** per D13.

---

## Tally (sub-audit C only)

- **New drifts found**: 14
  - **CRITICAL DRIFT**: 2 (D1, D2)
  - **DRIFT**: 9 (D3, D5, D6, D7, D8, D9, D11, D13, D14)
  - **SPEC SELF-CONTRADICTION**: 1 (D4)
  - **MINOR DRIFT**: 1 (D12)
  - **N/A** (inert column, intentional): 1 (D10)
- **Parent rows reclassified**: 5 of 11 ALIGNED rows are now found to carry latent drifts (T5.1, T5.3, T5.4, T5.5, T5.7, T5.10, T5.11). Parent's tally ALIGNED count for T5.x drops from 11/13 to roughly 4/13 once these are folded in.

---

## Top 3 ship-risk drifts (ordered)

1. **D2 — capture-source orchestrator never wired (CRITICAL)**. Every named ch09 §1 source is dead. `uncaughtException` → exit without crash_log row. T5.11 PR #920 shipped a 516-line module that runs only in tests. Fix: 1 import + 1 call in `index.ts`'s `runStartup`. ~10 lines.
2. **D1 — `state/` segment drift in `state-dir/paths.ts` (CRITICAL)**. Code/test/spec disagreement on where `ccsm.db` and `crash-raw.ndjson` actually live. Tests freeze the wrong layout. Affects installer DACL setup, backup tooling, on-disk forensics. Fix: amend spec OR fix code+tests; either is a single-PR change.
3. **D3 + D4 — crash-raw replay not wired AND spec self-contradicts on truncate vs offset (DRIFT + SPEC)**. The recovery NDJSON sidecar is the FOREVER-STABLE crash escape hatch when SQLite is down. Today it's append-only AND never read back. Fix needs (a) decision on ch07 §6 vs ch09 §2 strategy, (b) wiring the chosen impl into `runStartup`. ~15 lines.

---

## Top non-blocking sub-audit observations

- **D5 + D6 (coalescer dormant + no crash_log on disk-class fail)** are loud-bug-shaped but only become live once T6.x pty-host integration ships. Worth queueing as part of the T6.x branch, not a v0.3 ship blocker on its own — but the coalescer's "FOREVER-STABLE failure handling" claim needs the wiring to be real.
- **D8 (test inventory)** — 6 of 7 ch07 §8 spec files missing is striking, but the actual coverage is partly there at adjacent paths. Cheapest fix: rename + relocate existing tests, write missing 3 (write-coalescer-overflow, disk-full-degraded, cwd-state-osc7). This intersects with D5/D6/D13 — those tests exist as plans but the integration wiring they need also doesn't exist.
- **D11 (v0.2 → v0.3 migration)** — biggest "spec says ship, no task exists" gap in T5.x. Either drop ch07 §4.5 from spec or file a task. Doing nothing leaves a forever-stable narrative committed but unsupported.
- **D9 (check-migration-locks.sh CI hook)** is pre-tag latent (script no-ops); becomes meaningful only AFTER v0.3.0 GitHub release exists. Wire it into ci.yml during the T0.8 fix PR (#906).
- **D14 (snapshot doesn't explicitly block delta queue)** — JS single-thread papers over the missing gate. v0.4 multi-thread workers would surface it. Document the implicit invariant in the code, even if not enforced.

---

## Methodology

1. Read the parent baseline (`research/2026-05-03-spec-reconciliation:docs/research/2026-05-03-v03-spec-reconciliation-audit.md`) end to end.
2. Read spec ch07 + ch09 line by line on `working` branch (commit `53c43d2`).
3. For each parent T5.x row marked ALIGNED, traced from the cited PR to the actual file at HEAD, then grep-cross-checked the wiring (`installCaptureSources`, `replayCrashRawOnBoot`, `WriteCoalescer`, `checkAndRecover`, `startSystemdWatchdog`, `runMigrations`, `CrashPruner`, `crash-raw.offset`, `migration-staging`, `sqlite_synchronous`, `wal_autocheckpoint_pages`, `sqlite_write_failure`, `pty_snapshot_write`, `sqlite_queue_overflow`).
4. For each ch07 §8 named test path, asserted file existence at the spec-stated location.
5. For each ch09 §1 named source, traced to `CAPTURE_SOURCES` in `crash/sources.ts` and to entrypoint wiring.
6. Confirmed the `state/` segment drift via the test file (`paths.spec.ts`) so the discrepancy is real and not a transient code edit.

No production code modified. No PR opened. Branch: `research/2026-05-03-spec-recon-T5`.
