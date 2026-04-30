# Fragment: §8 SQLite migration story (v0.2 → v0.3)

**Owner**: worker dispatched per Task #937
**Target spec section**: new §8 in main spec (after §7 security)
**P0 items addressed**: #1 (SQLite migration — UX critical from review)

## What to write here
Replace this section with actual `## 8. Data migration: v0.2 → v0.3`
markdown. Cover:

1. **Source location (v0.2)**: `app.getPath('userData')/...` — exact filenames
   (sessions.db, settings.json, etc.). Check existing v0.2 code in
   `electron/store/**` for actual paths and DB filenames; cite.
2. **Target location (v0.3)**: `~/.ccsm/data/` (cross-platform: Win
   `%USERPROFILE%/.ccsm/data/`, Mac/Linux `$HOME/.ccsm/data/`). Daemon owns
   this dir.
3. **Migration trigger**: daemon's first-boot check.
   - If `~/.ccsm/data/sessions.db` exists → skip.
   - Else if `app.getPath('userData')/sessions.db` exists (Electron passes
     v0.2 path to daemon via env var on first launch) → migrate.
   - Else → fresh install, init empty db.
4. **Migration steps (atomic)**:
   - Copy v0.2 db file to `~/.ccsm/data/sessions.db.tmp`.
   - Open with better-sqlite3, run any v0.2 → v0.3 schema diffs (list them
     here; if none, just integrity check).
   - `fs.renameSync` `.tmp` → `sessions.db` (atomic on same filesystem).
   - Write marker `~/.ccsm/data/.migration-v0.3.done` with timestamp.
   - Leave v0.2 db in place untouched (rollback safety; user can downgrade).
5. **Failure modes**:
   - Disk full / permission → daemon logs, sends `MigrationFailedEvent` to
     Electron, UI shows actionable dialog ("contact support / try again /
     skip and start fresh"). Daemon stays up but data API returns
     `MIGRATION_PENDING`.
   - Schema mismatch (corrupted v0.2 db) → log, surface to UI, do NOT
     auto-overwrite.
6. **Rollback**: user can manually delete `~/.ccsm/data/`; daemon detects
   missing db on next boot and re-runs migration.
7. **Telemetry**: log migration duration, source size, success/fail to
   pino logs (no remote telemetry in v0.3).
8. **Test plan**: e2e test that seeds a v0.2 userData db, boots v0.3 daemon,
   asserts data appears in `~/.ccsm/data/`, original untouched.

Cite findings from `~/spike-reports/v03-review-ux.md`.

## Plan delta
- New Task 8 (was placeholder): "SQLite migration v0.2 → v0.3"
  - Migration logic (+4h)
  - First-boot detection wiring (Electron → daemon env handoff) (+2h)
  - Failure UI + IPC event (+3h)
  - e2e test seeding v0.2 db (+3h)
  - Total: ~12h
- Existing data layer task gains: factor out path config to make migration
  atomic (+1h).
