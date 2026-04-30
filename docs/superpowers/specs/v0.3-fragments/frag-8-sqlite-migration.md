# Fragment: §8 SQLite migration story (v0.2 → v0.3)

**Owner**: worker dispatched per Task #937
**Target spec section**: new §8 in main spec (after §7 security)
**P0 items addressed**: MUST-1 from `~/spike-reports/v03-review-ux.md` ("v0.2 → v0.3 SQLite migration is unspecified — every session, every title, every setting gone")

---

## 8. Data migration: v0.2 → v0.3

### 8.1 What v0.2 actually writes (grounded)

Source-of-truth grep on `working` tip: the only Electron call to
`app.getPath('userData')` lives in `electron/db.ts:124`. Every other
v0.2 persistence path either targets the user's CLI dir (`~/.claude/...`,
owned by Claude CLI, not by ccsm) or is in-memory.

ccsm-owned files inside `userData`:

| File | Producer | Notes |
|---|---|---|
| `ccsm.db` | `electron/db.ts:126` (`new Database(path.join(dir, 'ccsm.db'))`) | Single SQLite database. Schema = one table, `app_state(key TEXT PRIMARY KEY, value TEXT, updated_at INTEGER)` (`db.ts:43-49`). `PRAGMA user_version = 1` (`db.ts:17`). |
| `ccsm.db-wal` | better-sqlite3 in WAL mode (`db.ts:130`) | Sidecar. May contain uncheckpointed writes. |
| `ccsm.db-shm` | better-sqlite3 in WAL mode | Shared-memory index for the WAL. |
| `ccsm.db.corrupt-<ts>` | `db.ts:96` | Backup created when `quick_check` fails. Treat as user-owned forensic file — copy if present, do not open. |

`userData` resolves per Electron docs to (verified against
`package.json:5` `productName: "CCSM"` and `:113` `appId: com.ccsm.app`):

- **Win**: `%APPDATA%\CCSM\` → typically `C:\Users\<user>\AppData\Roaming\CCSM\`
- **macOS**: `~/Library/Application Support/CCSM/`
- **Linux**: `~/.config/CCSM/` (XDG)

Dev installs use `productName "CCSM Dev"` / `appId com.ccsm.app.dev`
(`package.json:31`) → `%APPDATA%\CCSM Dev\` etc. Migration MUST honor
the same product-name suffix that the running Electron build was
configured with — see §8.4 for handoff.

There are NO other ccsm-owned files in `userData` today. `electron/memory.ts`
writes only to `~/.claude/CLAUDE.md` (CLI-owned, untouched by upgrade).
`electron/sessionTitles/**` round-trips through the SDK to
`~/.claude/projects/<key>/<sid>.jsonl` (CLI-owned, untouched). `electron/prefs/**`
(closeAction, crashReporting, notifyEnabled, userCwds) all persist via
`saveState`/`loadState` → rows in the same `app_state` table inside
`ccsm.db`. So the migration surface is exactly **one .db file plus its
two WAL sidecars**, and the v0.2-corrupt-backup as a courtesy copy.

### 8.2 Target location (v0.3) — OS-native data root

`<dataRoot>` is OS-native per frag-11 §11.6: `%LOCALAPPDATA%\ccsm\` on
Windows, `~/.local/share/ccsm/` on Linux, `~/Library/Application
Support/ccsm/` on macOS. v0.2 → v0.3 migration moves data from legacy
`~/.ccsm/` to `<dataRoot>`; see §8.3 step 1.

[manager r5 lock: `<dataRoot>` placeholder, frag-11 §11.6 is single
source of truth; reason: install path locked to `%LOCALAPPDATA%` in r3
to avoid UAC, all sibling paths follow.]

**Rationale (round-3 arch lock, round-5 dataRoot reconciliation)**:
v0.2 used the cross-platform `~/.ccsm/` location for both daemon
runtime files and (via Electron's `userData`) the database. v0.3
consolidates everything daemon-owned — database, logs, crash dumps,
lockfile, `daemon.secret`, migration markers, corrupt-backups — under
the single OS-native `<dataRoot>` defined by frag-11 §11.6. This
matches v0.3's install path policy (installer drops binaries under the
same per-user OS-native root; data follows the same convention so
backup tools, antivirus exclusion lists, and MDM policies behave
predictably) and eliminates the three-way `<dataRoot>` permutation
flagged in r4 packaging review.

Daemon owns the data root at (per frag-11 §11.6 paths table):

- **Windows**: `%LOCALAPPDATA%\ccsm\` → typically `C:\Users\<user>\AppData\Local\ccsm\`
- **macOS**: `~/Library/Application Support/ccsm/`
- **Linux**: `~/.local/share/ccsm/` (frag-11 §11.6 fixed this row to the per-user
  OS-native root; `$XDG_DATA_HOME` is not consulted, matching frag-11)

Inside that root (subset relevant to migration; full table in frag-11
§11.6):

- `<dataRoot>/data/ccsm.db` — the database
- `<dataRoot>/data/migration-state.json` — the migration marker (§8.5 S8)
- `<dataRoot>/data/ccsm.db.corrupt-*` — quick_check corrupt-backups (carried
  over from legacy by §8.5 S7)
- `<dataRoot>/data/ccsm.db.migrating[-wal][-shm]` — transient migration tmp
  (cleared by §8.3 step 1a)
- `<dataRoot>/logs/daemon.log` — pino-roll output (owned by frag-6-7 §6.6)
- `<dataRoot>/crashes/` — crash dumps (owned by frag-6-7 §6.6.3)
- `<dataRoot>/daemon.lock` — daemon-singleton lockfile (owned by frag-6-7 §6.4)
  [manager r11 lock: lockfile name unified to daemon.lock per frag-6-7 majority; r10 devx P1-3]

Throughout the rest of this fragment, `<dataRoot>` refers to whichever
of the three OS-native paths above resolves on the current platform.
The implementation MUST use the same per-OS resolver as the installer
(frag-11 §11.6) and MUST NOT hard-code `~/.ccsm/...` for any v0.3 path.
The legacy `~/.ccsm/...` paths were interim round-1/round-3 placeholders
and are **no longer used** in v0.3; they appear in §8.3-§8.8 only as
v0.2 migration sources.

Filename stays `ccsm.db` (NOT renamed to `sessions.db` or `ccsm.sqlite` —
both appear as guesses in the v1 stub and the UX report; the on-disk
truth is `ccsm.db`).

**Note on the legacy v0.2 source path**: v0.2 itself stored
`ccsm.db` in Electron's `userData` (per-product-name path under
`%APPDATA%\CCSM\`, `~/Library/Application Support/CCSM/`, `~/.config/CCSM/`).
That is the **migration source** path resolved by §8.4
`resolveLegacyDir()`. The v0.2 `~/.ccsm/` directory (added late in
v0.2 for the daemon socket only — pre-database-move) never contained
user data and is not a migration source candidate.

### 8.3 Migration trigger (daemon first-boot)

The daemon, on every boot, runs `ensureDataDir()` BEFORE
`new Database(...)`. **Lockfile ordering (round-3 reliability P0-R4
fix)**: the daemon-singleton lockfile (`<dataRoot>/daemon.lock`,
owned by frag-6-7 §6.4) MUST be acquired BEFORE `ensureDataDir()`
runs. This closes the documented race where step 1a's unconditional
`unlink(<dataRoot>/data/ccsm.db.migrating*)` could otherwise delete a
**live** tmp file owned by a concurrent migrating daemon (e.g. user
double-clicked the launcher, MDM relaunch, debugger-spawned instance).
With lockfile-first, only one daemon ever reaches `ensureDataDir()`
per host; step 1a's "orphan unlink" is therefore provably orphan,
not racy. frag-6-7 §6.4 carries the matching note in its boot-order
list. The §8.8 e2e probe exercises two daemons racing boot to verify
the second one bails on lockfile rather than entering step 1a.

```
0.  acquireLockfile(<dataRoot>/daemon.lock)  // frag-6-7 §6.4 — blocks/exits if held
1.  mkdirSync(<dataRoot>/data, recursive: true)
1a. // Recover from any prior interrupted migration. Orphan tmp files
    // (from kill -9 between S3 and S6, OR from a pre-S6 throw whose
    // finally block could not run because the process died) leak both
    // disk space and downstream confusion (S3's "tmpDb already exists"
    // ambiguity). Unlink unconditionally before evaluating step 2.
    // Safe to do unconditionally because step 0 has already proven we
    // are the sole daemon on this host.
    for ext of ['', '-wal', '-shm']:
        unlinkIfExists(<dataRoot>/data/ccsm.db.migrating + ext)
2.  state = readMigrationState(<dataRoot>/data/migration-state.json)
    if state and state.completed:    return  // fast path; see §8.5 marker shape
3.  if exists(<dataRoot>/data/ccsm.db):
        // user installed v0.3 fresh OR migration already ran without marker
        // (e.g. legacy v0.3.0 install before marker.version=1 existed).
        // Do not re-migrate. Stamp the marker and return.
        writeMarker({ completed: true, reason: 'preexisting' }); return
4.  legacyDir = resolveLegacyDir()  // see §8.4 — env var + canonical-path validation
5.  if !legacyDir or !exists(join(legacyDir, 'ccsm.db')):
        // fresh install. Open new db, schema runs, marker stamped.
        writeMarker({ completed: true, reason: 'fresh-install' }); return
6.  runMigration(legacyDir)  // §8.5
```

Step 0's lockfile is the cross-process serialization gate. Step 2's
marker is the per-host "do not touch user data" gate. Once
`completed: true` is stamped, the legacy dir is never re-evaluated,
so a user who reinstalls v0.2 and accumulates new data alongside v0.3
cannot have their v0.3 db silently overwritten.

Step 1a closes the **partial-write data-loss bug** (round-2 reliability
P0-R4): without it, kill -9 between S3 and S8 leaves `ccsm.db.migrating`
on disk with no marker; on next boot step 3 misses (no `ccsm.db`),
step 5 may then trigger ENOSPC because the orphan ate the free space,
the user clicks "Start fresh anyway", marker stamps `user_skipped`,
**legacy data is silently abandoned**. By unlinking unconditionally at
step 1a (after lockfile acquisition), the next boot retries cleanly
with full free space.

### 8.4 Electron → daemon path handoff

The daemon process has no `electron` package dependency (plan §Phase 2);
it cannot call `app.getPath('userData')` itself. Electron computes the
legacy dir and passes it to the spawned daemon via env var.

**Env var name (locked)**: `CCSM_LEGACY_USERDATA_DIR`

(Round-2 lock-in P0-3: renamed from the worker's first draft
`CCSM_V02_USERDATA_DIR`. The "v02" suffix would force every future
release to either keep that name forever — semantic confusion when v0.4
itself becomes "legacy" — or invent `CCSM_V03_USERDATA_DIR` and
accumulate one env var per release. The generic `LEGACY` name is
version-neutral; the marker file (§8.5 S8) carries the actual source
schema version, so no information is lost.)

`electron/main.ts` (modified by plan Task 8) computes the value
unconditionally on every spawn (cheap; just a string):

```ts
const legacyUserData = app.getPath('userData');
spawn(daemonBin, [...], {
  env: { ...process.env, CCSM_LEGACY_USERDATA_DIR: legacyUserData },
  ...
});
```

Why every spawn (not just first):

- The daemon owns the "is migration needed?" decision via the marker
  file. Electron passing the var on every spawn is idempotent — the
  daemon ignores it once `migration-state.json` shows `completed: true`.
- A user who deletes `<dataRoot>/` (the OS-native data root) to force
  re-migration (rollback path, §8.7) gets correct behaviour on the
  next Electron launch without needing a special "first-boot" flag
  in Electron.

**`resolveLegacyDir()` — env-var trust validation (round-2 security P0-S2)**

`process.env.CCSM_LEGACY_USERDATA_DIR` is **attacker-controllable
input**. A same-user-equivalent process (launcher shim, MDM-deployed
wrapper, planted shortcut to `ccsm.exe`, debugger, or any
`CreateProcess`-with-env caller) can point this var at
`\\attacker-smb\share\`, `/tmp/planted/`, or any path. Step S4 below
opens that path with better-sqlite3 — every historical SQLite reader
CVE (CVE-2019-8457, CVE-2020-15358, etc.) becomes triggerable from
attacker-supplied bytes.

`resolveLegacyDir()` MUST:

1. **Allowlist** the supplied path against the OS-canonical
   Electron-userData locations for both prod (`CCSM`) and dev
   (`CCSM Dev`) builds:
   - Win: `%APPDATA%\CCSM` or `%APPDATA%\CCSM Dev`
   - macOS: `~/Library/Application Support/CCSM` or `~/Library/Application Support/CCSM Dev`
   - Linux: `~/.config/CCSM` or `~/.config/CCSM Dev` (XDG)

   Comparison uses `path.resolve` + case-insensitive equality on Win/macOS,
   case-sensitive on Linux. A path that does not exact-match one of these
   four candidates is rejected.
2. **Realpath** the supplied path (`fs.realpathSync.native`). Reject
   if the realpath:
   - traverses outside the user profile root (`os.homedir()` on POSIX,
     `%USERPROFILE%` on Win),
   - resolves to a network mount (Win: starts with `\\` or maps to a
     `\\` UNC after `QueryDosDeviceW`; POSIX: `statfs.f_type` in the
     network-fs set, or path begins with `/Volumes/` on macOS for
     non-root volumes — accepted only if also under home),
   - resolves to a symlink loop or broken link.
3. **Realpath** `join(legacyDir, 'ccsm.db')` independently and re-check
   the realpath is still under the validated `legacyDir` (defense
   against a symlink planted as `ccsm.db` pointing elsewhere).
4. **Trust contract (round-3 P1)**: the allowlist + double-realpath
   pair is the **only** trust boundary on `CCSM_LEGACY_USERDATA_DIR`.
   No downstream code (S3 backup open, S7 corrupt-backup glob, "Reveal
   old file" shell open) MAY use the raw env var; all four call sites
   consume the validated `legacyDir` returned by `resolveLegacyDir()`.
   A single unit test asserts `process.env.CCSM_LEGACY_USERDATA_DIR`
   is read exactly once per daemon boot (inside `resolveLegacyDir()`)
   so future refactors cannot accidentally re-introduce raw-env reads.

On rejection: emit `MigrationFailedEvent{reason: 'invalid_legacy_path',
supplied: <raw>, realpath: <resolved>}`, log a single pino line at
`warn`, modal copy "ccsm couldn't verify your previous data location"
with a single "Quit ccsm" button (no retry — env var won't change
without restart). Unit tests per rejection branch are required (plan
delta 8a).

If the daemon was started independently (e.g. `pkg`-bundled CLI
invocation, no Electron), `CCSM_LEGACY_USERDATA_DIR` is unset.
`resolveLegacyDir()` returns null and §8.3 step 5 proceeds as fresh
install. This is correct — only Electron knows the per-OS userData
path; a CLI-only daemon launch by definition is not an upgrade from
v0.2 (v0.2 had no headless mode).

**Dev-build interaction**: `productName` differs between prod (`CCSM`)
and dev (`CCSM Dev`) builds (`package.json:31`). `app.getPath('userData')`
already returns the right one for whichever Electron the user is
running, so no extra branching is needed — Electron passes whichever
is correct, daemon's allowlist accepts both, and rejects everything
else.

**Dev-mode trigger hook (round-2 devx S-5)**: contributors testing the
migration UI itself can set `CCSM_DEV_MIGRATION_FIXTURE=<dir>` (only
honoured when `NODE_ENV=development` AND the daemon binary is the dev
build) to bypass the canonical-path allowlist for that specific
fixture dir. Production builds ignore this var unconditionally.

### 8.5 Migration steps (atomic, recoverable)

`runMigration(legacyDir)` body. Every numbered step emits a structured
pino line `{ phase: '<name>', traceId, ts, durationMs, sourcePath, ... }`
(round-2 observability P1-2) so post-mortem from `<dataRoot>/logs/daemon.log`
alone is sufficient when the modal has been dismissed.

```
START. start = Date.now(); traceId = randomUUID()
       log.info({phase:'migration_started', traceId, sourcePath: legacyDb})

S1. legacyDb = join(legacyDir, 'ccsm.db')
S2. tmpDb    = join(<dataRoot>, 'data', 'ccsm.db.migrating')
    cleanup = () => for ext of ['', '-wal', '-shm']: unlinkIfExists(tmpDb+ext)

S3. // Use better-sqlite3's online .backup() API instead of fs.copyFileSync
    // of main+WAL+SHM. Round-1 reviewer MUST-FIX (corruption-as-success
    // risk): copyFileSync of three live SQLite files is non-atomic — if
    // a v0.2 process is still running and checkpoints between our
    // copies of `-wal` and `ccsm.db`, the resulting tmpDb has a stale
    // sidecar pointing at a different main file generation, which
    // SQLite happily opens and serves CORRUPT QUERIES with no error.
    //
    // .backup() opens a read transaction, writes a single self-consistent
    // page-by-page snapshot to tmpDb (no sidecars produced), and is the
    // SQLite-blessed way to copy a live db. It is also async-pageable
    // (default 100 pages per tick) which keeps the daemon event loop
    // responsive — closes round-2 perf P1-A (200 MB blocking copy starves
    // /healthz, triggering supervisor restart cycle).
    try {
      source = new Database(legacyDb, { readonly: true })  // no WAL contention
      log.info({phase:'migration_copy_started', traceId, bytes: statSync(legacyDb).size})
      await source.backup(tmpDb, { progress: ({totalPages, remainingPages}) => {
        // [manager r11 lock: NEW-1 — progress observed via daemon log only;
        // renderer modal is indeterminate spinner per §8.6 r9 lock —
        // no MigrationProgressEvent IPC.]
        if (now - lastEmit > 250) log.debug({phase:'migration_copy_progress', traceId, totalPages, remainingPages})
      }})
      source.close()
      log.info({phase:'migration_copy_done', traceId, durationMs: now-start})
    } catch (err) {
      cleanup()
      log.warn({phase:'migration_failed', traceId, reason:'copy_failed', err: err.message})
      emit MigrationFailedEvent({reason: classify(err), detail: err.message})
      return  // §8.6 maps reason → modal
    }

S4. // Validate by opening read-only and running quick_check.
    // Wrapped in try/finally with cleanup() so any throw (corrupt file,
    // OOM during quick_check, EBUSY) unlinks tmpDb — round-1 reviewer
    // MUST-FIX #3.
    let storedVersion
    try {
      probe = new Database(tmpDb, { readonly: true })
      try {
        if (probe.pragma('quick_check', { simple: true }) !== 'ok') {
          probe.close()
          cleanup()
          log.warn({phase:'migration_failed', traceId, reason:'corrupt_legacy'})
          emit MigrationFailedEvent({reason: 'corrupt_legacy', path: legacyDb})
          return
        }
        storedVersion = probe.pragma('user_version', { simple: true })
      } finally {
        probe.close()
      }
      log.info({phase:'migration_validated', traceId, userVersion: storedVersion})
    } catch (err) {
      cleanup()
      log.warn({phase:'migration_failed', traceId, reason:'validate_threw', err: err.message})
      emit MigrationFailedEvent({reason: 'corrupt_legacy', path: legacyDb})
      return
    }

S5. // No schema migration needed for v0.2 → v0.3: SCHEMA_VERSION is still 1
    // (electron/db.ts:17). The lift is a pure path move. If a future
    // v0.4 bumps SCHEMA_VERSION, the existing `migrate(from, to)` hook
    // in dbService runs at first open of the moved db.
    if storedVersion > 1:
        log.warn({phase:'migration_future_version', traceId, userVersion: storedVersion})

S6. // Atomic publish — single rename of the main db file.
    //
    // ROUND-1 REVIEWER MUST-FIX #2: the previous draft renamed sidecars
    // FIRST then main db. That order is wrong:
    //   - .backup() never produces sidecars (S3 rewrite). There are no
    //     `-wal`/`-shm` files alongside tmpDb to rename.
    //   - Even if a future change reintroduced sidecar copies, sidecars-
    //     first leaves an orphan `ccsm.db-wal` in dataDir on partial
    //     failure (rename main throws after sidecar rename succeeded);
    //     the orphan WAL points at a non-existent main file and SQLite
    //     refuses to open `ccsm.db` on next boot when the user retries
    //     by deleting the marker — contaminating fresh-install retry.
    //
    // With .backup() we rename ONE file, atomic on POSIX (rename(2))
    // and Win32 (MoveFileEx + MOVEFILE_REPLACE_EXISTING on same volume).
    // No sidecars exist to leak. The dataDir parent is `<dataRoot>/data`
    // (one volume per OS-native location), so atomicity is guaranteed.
    try {
      renameSync(tmpDb, join(dataRoot, 'data', 'ccsm.db'))
      log.info({phase:'migration_finalized', traceId})
    } catch (err) {
      cleanup()  // unlink tmpDb if rename threw mid-way (Win EBUSY etc.)
      log.warn({phase:'migration_failed', traceId, reason:'finalize_failed', err: err.message})
      emit MigrationFailedEvent({reason: 'finalize_failed', detail: err.message})
      return
    }

S7. // Courtesy: copy any v0.2 corrupt-backups so a forensic trail is
    // preserved next to the live db. Best-effort, never fails the
    // migration. Round-2 resource P1-6: cap each copy at 100 MB; skip
    // larger files with a warn line so a 2 GB corrupt backup doesn't
    // double the user's disk usage during migration.
    //
    // Round-3 resource X1: ALSO cap aggregate corrupt-backups at 5
    // files in <dataRoot>/data (~500 MB ceiling at 100 MB/file). Before
    // copying, glob `<dataRoot>/data/ccsm.db.corrupt-*` already present
    // from prior boots; if (existingCount + thisCopy) > 5, delete the
    // oldest by mtime first so the newest 5 always win. This bounds
    // the migration's contribution to the `<dataRoot>` aggregate
    // disk-cap watchdog owned by frag-6-7 §6.6 (round-3 X1).
    for f of glob(legacyDir + '/ccsm.db.corrupt-*'):
        try {
          if statSync(f).size > 100 * 1024 * 1024:
            log.warn({phase:'migration_corrupt_backup_skipped', traceId, file: f, bytes})
            continue
          // enforce 5-file aggregate cap
          existing = glob(<dataRoot> + '/data/ccsm.db.corrupt-*').sort(by mtime asc)
          while existing.length >= 5:
            unlinkSync(existing.shift())  // delete oldest
            log.info({phase:'migration_corrupt_backup_evicted', traceId, file})
          copyFileSync(f, join(<dataRoot>, 'data', basename(f)))
        } catch { /* best-effort */ }

S8. // Marker file. NAME (round-2 lock-in P0-3): `migration-state.json`
    // not `.migration-v0.3.done`. The per-version-suffix pattern would
    // accumulate stat() calls every release (`.migration-v0.4.done`,
    // `.migration-v0.5.done`, ...). A single state file with a schema
    // version inside is cheaper and forward-compatible — round-2
    // fwdcompat P1-3 (markerSchemaVersion).
    writeFileSync(join(<dataRoot>, 'data', 'migration-state.json'), JSON.stringify({
        marker: { version: 1 },     // markerSchemaVersion — bump when shape changes
        completed: true,
        ts: Date.now(),
        sourcePath: legacyDb,
        sourceBytes: statSync(legacyDb).size,
        sourceUserVersion: storedVersion,
        durationMs: Date.now() - start,
        traceId,
        reason: 'migrated',          // 'migrated' | 'preexisting' | 'fresh-install'
                                     // [manager r9 lock: P1-3 — removed
                                     // 'corrupt_skipped' and
                                     // 'user_skipped_after_disk_full' from
                                     // the enum; the §8.6 r7 collapse to a
                                     // single Quit-only fatal-error modal
                                     // means the daemon never enters a skip
                                     // flow that would stamp those reasons.
                                     // Marker is simply not written on
                                     // failure.]
    }, null, 2))
    log.info({phase:'migration_completed', traceId, durationMs: Date.now()-start})

S9. // v0.2 db file stays in `userData` UNTOUCHED. Two reasons:
    //   - Rollback safety: user can uninstall v0.3, install v0.2,
    //     keep working. v0.3 only ever READ the legacy file via
    //     readonly Database open in S3.
    //   - Disk-full safety: if S6 partially failed mid-rename and we
    //     deleted the source, data is gone.
    // §8.7 documents user-driven cleanup.
    emit MigrationCompletedEvent({traceId, durationMs: Date.now() - start})
```

All filesystem ops in S3–S6 share one parent dir (`<dataRoot>`) so
the rename is on a single volume — atomic on every supported platform.

**Backwards-compat marker reader**: a v0.3.x daemon that has shipped
the older `.migration-v0.3.done` marker (if any pre-release builds did)
is handled by §8.3 step 2: `readMigrationState` returns
`{ completed: true, reason: 'preexisting' }` if the legacy marker file
exists, then step 2 returns. Step 3 also catches the case (db exists
without the new state file) and stamps fresh state.

**`MIGRATION_PENDING` short-circuit scope (round-2 reliability P1-R3)**:
the sentinel returned by data RPCs (plan delta 8e) does NOT apply to
supervisor-facing RPCs. Specifically `/healthz`, `/stats`, `/version`,
and the imposter-secret handshake (`ping()`) all respond normally,
with a top-level `migrationState: 'pending' | 'completed' | 'failed'`
diagnostic field. If `/healthz` returned `MIGRATION_PENDING` the
supervisor would treat the daemon as unhealthy and start a restart
cycle that the migration would never complete (round-trip P0).

### 8.6 Failure modes and user-facing UI

The daemon stays UP through every failure mode (so logs/IPC keep
working). Data-API calls return `{ ok: false, code: 'MIGRATION_PENDING',
detail: ... }` until the user resolves; supervisor RPCs respond
normally with a `migrationState` field (see §8.5 short-circuit scope).
Electron's data bridge translates the sentinel into a renderer-blocking
modal.

**[manager r7 lock: cut as polish — N5# from r6 feature-parity (with
C2# and N7# folded in). §8.6 modal flow trimmed from 6 copy variants
+ multi-button flow → ONE fatal-error modal matching working's
`installerCorrupt` prose pattern. Removed: per-failure-class copy
variants (disk-full / permission / corrupt-legacy / finalize-failed /
invalid-legacy-path), multi-button flows ("Retry" / "View log" /
"Reveal old file" / "Start fresh anyway" / Quit), the typed-confirm
"start fresh" word-gate, the `migration_corrupt_backup_skipped`
follow-up info-toast for disk-recovery, the `MigrationProgressEvent`
in-progress modal driver. KEPT: silent quick_check + auto-backup
behavior (matches working v0.2 `db.ts.corrupt-<ts>` pattern), the
single fatal-error modal below, structured pino phase-log emission for
post-mortem (§8.5 unchanged). Per r5 lock #9 ("View log button removed
entirely; no such feature in current working") + the §6.1.1 r7 trim,
the only modal action is "Quit ccsm".]**

**Single fatal-error modal** (registered with i18n key prefix
`migration.modal.failed.*` in frag-6-7 §6.8 surface registry, priority
85, and as the `Migration failed` row in §6.1.1):

| Failure trigger | Daemon log phase | IPC event | Modal copy |
|---|---|---|---|
| Any migration failure (S3 copy / S4 quick_check / S6 finalize / S4 invalid legacy path / disk-full / permission denied) | `migration_failed{reason: <classified>}` (six reason codes preserved in the structured log for post-mortem support) | `MigrationFailedEvent{reason, detail?}` (single event class; renderer dispatches to single modal) | **Title**: "ccsm couldn't migrate your previous data"<br>**Body**: "ccsm tried to move your data from the previous version but couldn't complete the migration. Your previous data file at `<legacyDb>` is preserved unchanged — quit ccsm and contact support, or manually start fresh by deleting `<dataRoot>` and relaunching." Buttons: "Quit ccsm" |

The body's `<legacyDb>` and `<dataRoot>` interpolations let the user
locate both source (untouched, recoverable) and target (delete-to-retry)
without a "Reveal old file" shell-open code path. The
manual-delete-and-relaunch path is the documented retry mechanism
(matches §8.7 user-driven rollback). No "Retry" button — a failed
quick_check or rename cannot retry within the same boot meaningfully;
the structural retry path is the manual cleanup + relaunch flow which
also clears any orphan tmp via §8.3 step 1a.

[manager r9 lock: P1-2 — orphan markdown table row "CCSM_LEGACY_USERDATA_DIR
unset → fresh-install silent path" deleted. Silent fresh-install path
is the implied default already documented in §8.3 step 5 +
§8.5 S8 reason='fresh-install'; no separate row needed in the §8.6
failure-modal table.]

[manager r7 lock: C2# from r6 feature-parity — "View log" button cells
in all former §8.6 modal rows are eliminated by the collapse to a
single fatal-error modal. Daemon log path documented in release notes
+ About dialog only (matches frag-3.7 r7 cut of "Open daemon log" tray
entry).]

[manager r7 lock: N5# additional sub-cut — "Reveal old file" button
also cut. Source path appears in modal body text; user can navigate to
it via Explorer / Finder manually. This avoids the
shell-open-attacker-path security gate (round-2 SH4) since no
shell.openPath call exists.]

[manager r7 lock: N5# additional sub-cut — "Start fresh anyway"
typed-confirm word-gate (former r2 ux P1-UX-2) and the disk-full
"your previous data is still recoverable" follow-up toast cut. Manual
delete-and-relaunch path documented in modal body + release notes is
the supported retry; no in-app affordance.]

All copy is sentence-case (per `feedback_no_uppercase_ui_strings`). No
copy contains "ERROR" / "FAILED" / "FATAL". i18n keys live under
`migration.modal.failed.*` in the standard bundle (canonical keys:
`migration.modal.failed.title`, `migration.modal.failed.body`,
`migration.modal.failed.actionQuit`). Renderer translates; daemon emits
structured events only. [manager r7 lock: r6 ux P0-3 — i18n key
namespace dot+camelCase per r3-T13. The §6.8 surface registry row's
"Owner i18n key prefix" column for the migration-failed modal is
updated from `daemon.migrationFailed` to `migration.modal.failed.*`
to match this canonical namespace; cross-fragment fixer H aligned both
sites.]

**Cross-fragment UI cohesion (round-2 ux P0-UX-1, P1; round-3 ux
clarification; r7 trim alignment)**: the migration modal is the only
migration-domain blocking surface in v0.3. The mutual-exclusion /
stacking contract is OWNED by frag-6-7 §6.8 "User-visible surface
registry". This fragment registers the migration in-progress modal as
**priority class P0 / mode `blocking-modal` / dismissable: false /
priority value 100** (the top of the §6.8 registry) and the
fatal-error modal under i18n key prefix `migration.modal.failed.*`
at **priority 85**. When
either is active, all other surfaces (toasts, banners, secondary
modals) are suppressed until resolved. Rationale: data-loss-class user
choice cannot share attention.

**Reconciliation with §6.8 stacking rule 1 (round-3 ux note)**: §6.8's
generic stacking rule says "if a higher-priority modal arrives, the
lower one is dismissed and its IPC re-fires." Migration in-progress is
the highest-priority modal in the entire registry (priority 100), so
stacking rule 1 NEVER fires against it — there is no higher-priority
modal that could displace it. `dismissable: false` is therefore both a
property of this modal AND a structural consequence of being priority
100; the two specs do not conflict. The §6.8 registry entry is the
contract; this section's copy is the authority for migration-specific
strings.

**In-progress modal: indeterminate spinner, no event needed (manager r9
lock)**. The priority-100 in-progress modal at §6.8 is rendered as a
simple indeterminate spinner with copy "Migrating data, please wait..."
shown for the duration of `runMigration()`. Lifecycle:

- **shown**: when the daemon emits `MigrationStartedEvent` (S3 START
  log line in §8.5 already carries `phase:'migration_started'`; an
  IPC event of the same name is added — zero-cost, single fire).
- **dismissed**: on `MigrationCompletedEvent` (S9) OR when
  `MigrationFailedEvent` arrives and the priority-85 fatal-error modal
  takes over.

No `MigrationProgressEvent` and no `{totalPages, remainingPages}` IPC
stream is required — the §8.5 S3 `.backup()` callback's progress hook
is retained ONLY for the structured pino phase log (post-mortem),
not for renderer wire-up. Rationale: r7 trim cut per-failure copy
variants and the typed-confirm flow; the only renderer state needed
is "are we mid-migration? yes/no", which two events (started +
completed/failed) supply. This preserves the §6.8 priority-100 row
without re-introducing the `MigrationProgressEvent` contract that the
§8.6 r7 lock removed.

[manager r9 lock: in-progress modal kept (frag-6-7 §6.8 P=100 row
remains valid); driven by start/complete/failed events only; no
progress event in renderer protocol. Decision recorded here so frag-6-7
§6.8 reciprocal sweep (separate fixer) does not need to cut the row.]

### 8.7 Rollback paths

- **User wants to go back to v0.2**: uninstall v0.3, install v0.2.
  v0.2's `app.getPath('userData')/ccsm.db` was never touched, so it
  resumes exactly as before. Any work done in v0.3 lives only in
  `<dataRoot>/` (OS-native) and is invisible to v0.2 — this is
  documented in the v0.3 release notes.

- **User wants to re-run migration** (e.g. after a failed migration
  surfaced via the §8.6 fatal-error modal): the documented manual path
  is — quit ccsm, delete `<dataRoot>/` (the OS-native data root, full
  path printed in the §8.6 fatal-error modal body text per the r7
  trim — no in-app "Start fresh" button or "View log" toast exists),
  relaunch. Daemon's §8.3 step 0 acquires lockfile, step 1a clears
  any orphan tmp, step 2 misses (state file gone), step 3 misses (db
  gone), step 5 fires, state file re-stamped.
  [manager r9 lock: §8.6 r7 trim cut both the "Start fresh" button
  and the "View log" toast; rollback path now relies on the modal's
  body-text path interpolation + manual delete + relaunch as the only
  retry mechanism.]

- **User has data in BOTH dirs after running v0.2 again post-migration**:
  the daemon never re-considers the legacy dir once the marker exists.
  Documented as a known limitation; release notes recommend "pick a
  version and stick with it for the v0.3 release window".

- **Post-rollback health validation (round-3 P1)**: after any
  user-driven rollback path above, the daemon's first boot MUST pass
  the supervisor's standard `/healthz` 5-ping verification (frag-6-7
  §6.4 step 7's "60s up + 5×/healthz" gate, reused) BEFORE the
  renderer is allowed to issue data-write RPCs. If the post-rollback
  daemon fails `/healthz` (e.g. corrupt state file written by the
  prior failed migration, missing OS-native parent dir on locked-down
  systems), supervisor surfaces the standard daemon-spawn-failure
  modal (frag-6-7 §6.1) — NOT the migration modal — so the user
  understands this is a daemon problem, not a migration problem.
  The migration sub-system's only post-rollback contribution is to
  re-run §8.3; the health gate itself is owned by frag-6-7.

### 8.8 Test plan

E2E probe (`tests/electron-daemon-migration.e2e.ts`, new — folded
into `harness-agent` per `feedback_e2e_prefer_harness`):

1. Setup: synthesize a v0.2 `ccsm.db` in a temp dir mimicking
   `app.getPath('userData')`. Seed the `app_state` table with three
   recognizable rows (e.g. `closeAction=hide`, `notifyEnabled=true`,
   `userCwds=["C:\\repo"]`). Set `HOME` and `CCSM_LEGACY_USERDATA_DIR`
   to point Electron and daemon at the temp dirs. The fixture dir is
   inside the test's temp `HOME`, so it passes the §8.4 canonical-path
   allowlist (test runs in dev mode so `CCSM_DEV_MIGRATION_FIXTURE` may
   alternatively be used to bypass — both code paths must be tested).
2. Boot ccsm v0.3.
3. Assert: `<dataRoot>/data/ccsm.db` exists (where `<dataRoot>` is
   `%LOCALAPPDATA%\ccsm\` on Win, `~/Library/Application Support/ccsm/`
   on mac, `~/.local/share/ccsm/` on Linux); reading it via
   better-sqlite3 returns the three seeded rows.
4. Assert: legacy `<tempUserData>/ccsm.db` is byte-identical to the
   pre-boot snapshot (`statSync(...).mtimeMs` AND sha256 unchanged).
5. Assert: `<dataRoot>/data/migration-state.json` exists and parses to
   `{marker: {version: 1}, completed: true, ts, sourcePath, sourceBytes,
   sourceUserVersion: 1, durationMs, traceId, reason: 'migrated'}`.
6. Reboot daemon. Assert no second migration runs (`migration_started`
   log line absent; state-file `ts` unchanged).
7. Assert daemon log contains the full structured phase chain:
   `migration_started` → `migration_copy_started` → `migration_copy_done`
   → `migration_validated` → `migration_finalized` → `migration_completed`,
   each with the same `traceId`.

Failure-path probes (parameterized):

- **Disk full**: mock the `.backup()` callback to throw `ENOSPC` after
  N pages. Assert daemon stays up, IPC returns `MIGRATION_PENDING`,
  no `<dataRoot>/data/ccsm.db` created, no state file, legacy file
  untouched, AND no orphan `ccsm.db.migrating` left behind (try/finally
  cleanup verified).
- **Corrupt legacy**: seed `ccsm.db` with garbage bytes. Assert
  `MigrationFailedEvent{reason: 'corrupt_legacy'}` fires, no state file,
  no `ccsm.db` in target.
- **Pre-existing target**: pre-create `<dataRoot>/data/ccsm.db` AND set
  `CCSM_LEGACY_USERDATA_DIR` to a populated legacy. Assert legacy is
  IGNORED (target untouched, state file stamped with `reason='preexisting'`).
- **Partial-write recovery (round-2 reliability P0-R4)**: pre-seed
  `<dataRoot>/data/ccsm.db.migrating` (and `-wal`, `-shm`) with garbage as
  if a prior boot died between S3 and S6. Boot daemon. Assert step 1a
  unlinks all three orphans BEFORE any other check; assert migration
  then runs cleanly (`reason='migrated'`); assert no orphans remain.
- **Lockfile-before-ensureDataDir ordering (round-3 reliability P0-R4
  fix)**: spawn two daemon processes simultaneously against the same
  HOME. Assert exactly one acquires the `<dataRoot>/daemon.lock`
  lockfile and proceeds into `ensureDataDir()`; the other exits with
  the standard "another daemon is running" error from frag-6-7 §6.4
  WITHOUT entering step 1a. Assert no `<dataRoot>/data/ccsm.db.migrating`
  is unlinked while the winner's S3 backup is mid-flight (probe by
  installing a `.backup()` progress callback that synchronously checks
  `existsSync(tmpDb)` returns true throughout the copy).
- **Security rejection — UNC path (round-2 security P0-S2)**: set
  `CCSM_LEGACY_USERDATA_DIR=\\some-host\share\fake` (Win) or
  `/mnt/nfs/fake` (Linux). Assert `MigrationFailedEvent{reason:
  'invalid_legacy_path'}` fires; assert `quick_check` was NEVER called
  on the supplied path (no SQLite open of attacker-controlled bytes);
  assert modal shows the no-retry copy.
- **Security rejection — symlink escape**: under temp HOME, create a
  symlink `<tempUserData>/CCSM/ccsm.db` → `/etc/passwd`. Assert
  realpath check rejects, no SQLite open of `/etc/passwd`.
- **Security rejection — out-of-allowlist canonical path**: set
  `CCSM_LEGACY_USERDATA_DIR=<dataRoot>` (the new dir itself, a
  loop). Assert allowlist rejects (path is not one of the four
  Electron-userData canonical names).
- **Aggregate corrupt-backup cap (round-3 resource X1)**: pre-seed
  `<dataRoot>` with 5 existing `ccsm.db.corrupt-2025-*` files (each
  10 KB, mtimes spread across one minute), then run a migration whose
  `legacyDir` contains 2 fresh corrupt-backups. Assert post-migration
  `<dataRoot>` contains exactly 5 corrupt-backup files (the 2 oldest
  pre-existing ones evicted), and a `migration_corrupt_backup_evicted`
  log line fires per eviction.
- **Marker forward-compat**: write a state file with
  `marker.version: 999` and `completed: true`. Assert daemon proceeds
  as fast-path (treats `completed: true` as authoritative regardless
  of marker version; future versions are responsible for backward-
  compatible reads).

### 8.9 What the migration does NOT cover (scope fence)

- **`~/.claude/**`**: CLI-owned. ccsm never wrote there for session
  data; sessionTitles round-trip via SDK, not via copy. Untouched on
  upgrade — Claude CLI handles its own data lifecycle.
- **Renderer localStorage / IndexedDB**: ccsm renderer does not persist
  to browser storage (verified — no `localStorage.setItem` call
  references user data; only the ephemeral UI state which is
  intentionally session-local and reset on refresh).
- **Schema upgrades**: SCHEMA_VERSION stays at 1 across v0.2 → v0.3.
  Future bumps reuse the existing `migrate(from, to)` hook from
  `electron/db.ts:57` (lifted to `daemon/src/services/dbService.ts`
  by plan Task 8); migration is path-only.

---

## Plan delta

Insert new sub-task after plan Task 8 Step 4 (the line that today
says "if `electron/db.ts` references `app.getPath('userData')`, replace
with the OS-native data root resolver"):

- **Task 8 (additional)**: data migration v0.2 → v0.3
  - **8a**: implement `ensureDataDir()` (resolves OS-native `<dataRoot>`
    via per-OS resolver: `%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application
    Support/ccsm/` mac, `~/.local/share/ccsm/` Linux) +
    `resolveLegacyDir()` (canonical-path allowlist + double-realpath
    validation, §8.4) + `runMigration()` per §8.3-§8.5 in
    `daemon/src/services/dbService.ts`. Lockfile (frag-6-7 §6.4)
    acquired BEFORE `ensureDataDir()` runs (round-3 reliability P0-R4
    fix). Uses better-sqlite3 `.backup()` API (NOT `fs.copyFileSync`),
    wrapped in try/finally with cleanup. Step 1a unconditional
    orphan-tmp unlink (safe because lockfile owns the host).
    Aggregate 5-file cap on corrupt-backups in `<dataRoot>` (round-3
    resource X1). +7h (was +6h: +1h for OS-native resolver + path
    test matrix per OS).
  - **8b**: Electron-side env-var handoff in `electron/main.ts` and
    `electron/lifecycle/spawnOrAttach.ts` (set `CCSM_LEGACY_USERDATA_DIR`
    on every daemon spawn, value = `app.getPath('userData')` which
    is the v0.2 product-name path under `%APPDATA%\CCSM\` etc). +1h.
  - **8c**: `MigrationStartedEvent` / `MigrationFailedEvent` /
    `MigrationCompletedEvent` in
    `daemon/src/api/contracts.ts` [manager r11 lock: NEW-2 —
    `MigrationStartedEvent` added to contracts enumeration; drives the
    §8.6 r9 in-progress spinner alongside Completed/Failed]; renderer
    modals in
    `src/renderer/components/MigrationDialog.tsx` — TWO surfaces:
    (1) priority-100 in-progress modal, indeterminate spinner with
    copy "Migrating data, please wait...", shown while sql.exec runs
    synchronously and dismissed on `MigrationCompletedEvent` /
    `MigrationFailedEvent` (no progress events needed — see §8.6
    in-progress-modal note); (2) priority-85 single fatal-error modal
    per §8.6 with the canonical `migration.modal.failed.*` i18n keys
    (Quit ccsm only). +2h (was +4h; r9 trim cut `MigrationProgressEvent`
    + the six per-failure-class copy variants + "Start fresh anyway"
    typed-confirm; remaining work is the two simple modals + two events).
    [manager r9 lock: scope reduced to match §8.6 r7 trim — no
    `MigrationProgressEvent`, no per-failure copy switch, no
    typed-confirm. In-progress modal retained as indeterminate spinner.]
  - **8d**: e2e probe per §8.8 (folded into `harness-agent`). Includes
    partial-write recovery test, lockfile-before-ensureDataDir ordering
    test (round-3 P0-R4), three security-rejection tests, aggregate
    corrupt-backup cap test (round-3 X1), marker forward-compat test,
    structured-phase log assertion. +5h (was +4h; +1h for the new
    lockfile-race + aggregate-cap cases).
  - **8e**: `MIGRATION_PENDING` short-circuit in `daemon/src/services/dbService.ts`
    so every public DATA RPC checks `migrationState` first and returns
    the sentinel until the user resolves. `/healthz`, `/stats`,
    `/version`, and the imposter-secret handshake bypass the
    short-circuit and return a `migrationState` field instead
    (§8.5 short-circuit scope). +1h.
  - **Subtotal**: ~16h (r9 trimmed 8c by 2h after §8.6 r7 cuts removed
    `MigrationProgressEvent` + per-failure copy variants + typed-confirm;
    prior r3 round was ~18h with the now-cut UX). Goes on
    the critical path for v0.3 release — cannot ship without
    (data-loss bug = RED per `~/spike-reports/v03-review-ux.md`
    MUST-1 and round-2 reliability P0-R4 + security P0-S2 + round-3
    reliability P0-R4 lockfile race).
    [manager r9 lock: subtotal recomputed after 8c trim.]

Existing plan Task 8 Step that says "replace `app.getPath('userData')`
with the OS-native data root resolver. Add a one-time `mkdirSync` at
module load" → AMEND to: "after lockfile acquisition (frag-6-7 §6.4
boot order), call `ensureDataDir()` (8a) which resolves the per-OS
`<dataRoot>`, performs the mkdir, orphan-tmp cleanup, AND the
migration check; do NOT open the database before it returns
successfully."

Release-notes addition (Task 24): one paragraph documenting (a) data
moves from the old per-product Electron-userData path to the OS-native
location automatically (`%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application
Support/ccsm/` mac, `~/.local/share/ccsm/` Linux), (b) old data left
in place for rollback, (c) "to start over, quit ccsm and delete the
ccsm folder under your OS-native application-data location" (full
path also printed in the §8.6 fatal-error modal body when migration
fails, and in the app's About dialog), (d) if migration fails, ccsm
shows a single "ccsm couldn't migrate your previous data" modal whose
only action is "Quit ccsm"; previous data file is preserved unchanged
and the manual delete-and-relaunch path above is the documented retry
mechanism (close-to-tray behaviour call-out from round-2 ux P0-UX-2
mitigation also lives here).
[manager r9 lock: (c) drops the stale "View log toast" reference; (d)
rewritten to describe the actual single Quit-only modal post §8.6 r7
trim, replacing the prior generic "close-to-tray behaviour" sentence
which lost its anchor when the migration UX collapsed.]

---

## Cross-frag rationale

Round-2 review surfaced 6 P0 items and 3 P1 items touching this
fragment. Ownership decisions:

| Item | Source | Owned here? | Rationale |
|---|---|---|---|
| Round-1 reviewer MUST-FIX #1: use `.backup()` not `copyFileSync` of WAL+main+SHM | independent reviewer | **YES** — applied in §8.5 S3 | Pure §8 internal mechanism. CRITICAL: `copyFileSync` of three live SQLite files is corruption-as-success risk (stale-sidecar non-atomicity). `.backup()` is the SQLite-blessed API and additionally solves perf P1-A (page-progress async, doesn't block event loop). |
| Round-1 reviewer MUST-FIX #2: rename main.db first OR sidecars-in-finally | independent reviewer | **YES** — applied in §8.5 S6 | With `.backup()` rewrite (#1) there are NO sidecars in tmpDb to rename — single rename, atomicity native. Fix is structural, not just ordering. |
| Round-1 reviewer MUST-FIX #3: try/finally wrap S3+S4 with unlink | independent reviewer | **YES** — applied in §8.5 S3 + S4 | Each step has explicit try/catch + cleanup; verified by §8.8 disk-full probe asserting no orphan tmp. |
| P0-R4 reliability: partial-write between S3 and S8 → silent data loss | r2-reliability | **YES** — §8.3 step 1a added | Daemon-internal recovery. Step 1a unconditional unlink of `ccsm.db.migrating[-wal][-shm]` before any other check; `MigrationFailedEvent.reason` differentiated `user_skipped_after_disk_full` from `corrupt_skipped` so support tooling can offer follow-up retry. |
| P0-S2 security: `CCSM_V02_USERDATA_DIR` attacker-controllable, no validation | r2-security | **YES** — §8.4 `resolveLegacyDir()` | Allowlist against four canonical Electron-userData paths, double realpath (dir + db file), reject UNC / network mount / symlink-escape. Five unit tests added (8a). `quick_check` cannot run until validation passes — closes SQLite-CVE attack surface. |
| P0-3 lock-in: env-var name + per-version marker are permanent contracts | r2-lockin | **YES** — renamed both | `CCSM_V02_USERDATA_DIR` → `CCSM_LEGACY_USERDATA_DIR` (version-neutral); `.migration-v0.3.done` → `migration-state.json` with `marker.version: 1` (single forward-compatible state file vs accumulating per-release marker files). Carries the actual source schema version inside, so no information loss. |
| P0-UX-1 cross-frag UI cohesion (modal/toast/banner stacking) | r2-ux | **PUNT to frag-6-7 §6.8** | Surface registry is naturally a frag-6-7 concern (it owns the supervisor banners + crash-loop modal — the other two blocking surfaces). This fragment registers its modal as priority class P0 / `blocking-modal` / non-dismissable in the registry; §8.6 footer documents the contract. The registry implementation lives in frag-6-7. |
| P1-R3 reliability: `MIGRATION_PENDING` short-circuit is too broad | r2-reliability | **YES** — §8.5 short-circuit scope + plan 8e | Data RPCs return sentinel; supervisor RPCs (`/healthz`, `/stats`, `/version`, `ping()`) respond normally with `migrationState` diagnostic field. Without this scoping the supervisor would crash-loop the daemon mid-migration. |
| P1-2 obs: structured pino phase log lines | r2-observability | **YES** — §8.5 START + every step | Six phase names (`migration_started`, `migration_copy_started`, `migration_copy_done`, `migration_validated`, `migration_finalized`, `migration_completed`) plus `migration_failed{reason}` and `migration_corrupt_backup_skipped`. All carry shared `traceId`. §8.8 step 7 asserts the chain. |
| P1-3 fwdcompat: marker schema version | r2-fwdcompat | **YES** — §8.5 S8 + §8.8 | `marker.version: 1` field in state file; e2e asserts shape; forward-compat test asserts `marker.version: 999` is treated as authoritative `completed: true`. |
| P1-A perf: sync `quick_check` blocks event loop | r2-perf | **YES** — `.backup()` rewrite + note | `.backup()` is page-paged async (default 100 pages/tick); event loop stays responsive during multi-second copy. `quick_check` itself runs synchronously on the read-only probe but only after copy completes — supervisor `/healthz` bypass (P1-R3) means even a 3s `quick_check` can't trigger restart. v0.4 follow-up: move `quick_check` to `worker_threads` if dogfood reveals user-visible jank. |
| P1-UX-2 ux: "start fresh" typed-confirm ambiguity | r2-ux | **YES** — §8.6 typed-confirm spec | Exact phrase `start fresh`, case-insensitive, no quotes/punctuation. Auto-focus, disabled-until-match button, screen-reader live region. |
| SH4 security: "Reveal old file" opens attacker path | r2-security | **YES — gated on P0-S2** | §8.6 explicitly notes the button only fires after §8.4 allowlist passed. With P0-S2 fix the path is provably canonical-userData, so Explorer-shell escalation vector is closed. |
| P1-6 resource: cap migration corrupt-backup copy | r2-resource | **YES** — §8.5 S7 | 100 MB per-file cap; oversize files logged as `migration_corrupt_backup_skipped` and skipped (user can copy manually). |
| SHOULD-2 resource: rename order | r2-resource | **YES — subsumed by MUST-FIX #2** | The `.backup()` rewrite eliminates sidecars in tmpDb; single rename of main file is the only finalize op. SQLite recreates sidecars on first open. |
| S-R2 reliability: `fs.copyFileSync` is sync-blocking | r2-reliability | **YES — subsumed by MUST-FIX #1** | `.backup()` is async-pageable; replaces the sync copyFileSync entirely. |
| Devx S-5: dev-mode trigger hook for migration UI | r2-devx | **YES** — §8.4 dev hook | `CCSM_DEV_MIGRATION_FIXTURE` honoured only when `NODE_ENV=development` AND dev-build daemon binary; production ignores. One-line escape hatch for contributors testing modal variants. |
| P1-2 observability: tray "Open log folder" shortcut | r2-observability | **PUNT to frag-6-7** | Tray menu is renderer/electron-main concern, not daemon. Frag-6-7 §6.6 logs section owns it. |
| P0-UX-2 ux: close-window toast deferral | r2-ux | **PUNT to frag-6-7 + release notes** | Not migration-specific. Mitigation: release-notes call-out (Plan delta release-notes addition (d)) is the agreed v0.3 mitigation; v0.4 reconsiders the deferral. |
| P0-UX-3 ux: daemon-spawn failure modal copy | r2-ux | **PUNT to frag-6-7 §6.1** | Spawn failure is supervisor's surface, not migration's. §8.6 modal style serves as a template. |
| P0-S1 security: `daemon.secret` lifecycle | r2-security | **PUNT to frag-6-7 §7** | Pre-migration concern; secret must exist at first boot regardless of migration state. Frag-6-7 owns secret creation/rotation. Confirmed still PUNT in r3 — `daemon.secret` is not in §8's scope. |
| **R3 arch lock**: data root = OS-native, not `~/.ccsm/data/` | r3-manager | **YES** — §8.2 rewrite | v0.2 used `~/.ccsm/` cross-platform (interim); v0.3 moves to OS-native (`%LOCALAPPDATA%\ccsm\` Win, `~/Library/Application Support/ccsm/` mac, `~/.local/share/ccsm/` Linux) to match install path policy. Source (legacy) stays at v0.2's Electron `userData` per-product-name path; only TARGET changed. All §8.3-§8.8 path references swept. |
| **R3 P0-R4 reliability**: lockfile-before-ensureDataDir ordering | r3-reliability | **YES** — §8.3 step 0 added | Lockfile (`<dataRoot>/daemon.lock`, frag-6-7 §6.4) acquired BEFORE `ensureDataDir()` so step 1a's unconditional unlink is provably orphan, not a race against a concurrent live migration. Matched by frag-6-7 §6.4 boot-order note. New e2e probe (§8.8) races two daemons. |
| **R3 X1 resource**: aggregate corrupt-backup cap | r3-resource | **YES** — §8.5 S7 amendment | Per-file 100 MB cap unchanged; ADDED 5-file aggregate cap with mtime-based oldest-first eviction (~500 MB ceiling). Bounds migration's contribution to the `<dataRoot>` aggregate disk-cap watchdog owned by frag-6-7 §6.6 (the broader X1 watchdog itself stays with frag-6-7). New e2e probe verifies eviction. |
| **R5 dataRoot reconciliation**: `~/.ccsm/` retired across data/logs/crashes/lockfile | r5-manager (frag-11 §11.6 lock) | **YES** — §8.2 rewrite + §8.3-§8.8 sweep | Three-way `<dataRoot>` permutation flagged in r4 packaging; manager r5 lock makes frag-11 §11.6 the single source of truth. All `~/.ccsm/data|logs|crashes|daemon.lock` references in §8.2-§8.8 mapped to `<dataRoot>/...` (db moves to `<dataRoot>/data/`, logs to `<dataRoot>/logs/`, crashes to `<dataRoot>/crashes/`, lockfile to `<dataRoot>/daemon.lock`). Legacy `~/.ccsm/` references retained only in historical/rationale prose to describe the v0.2 starting state. |
| **R3 P1 perf**: `.backup()` already adopted | r3-perf | **YES — confirm only** | r3-perf §P1-A confirms §8.5 S3 already uses `.backup()` page-paged async with indeterminate spinner driven by MigrationStartedEvent + MigrationCompletedEvent/MigrationFailedEvent (no progress IPC). No change needed; structural fix from r2 carried through. [manager r11 lock: NEW-3 — phrasing aligned with §8.6 r9 lock that removed `MigrationProgressEvent`.] |
| **R3 ux clarification**: dismissable: false vs §6.8 stacking rule 1 | r3-ux | **YES** — §8.6 reconciliation paragraph | r3-ux flagged apparent contradiction; clarified that `dismissable: false` is consistent with §6.8 priority 100 because no higher-priority modal exists to trigger stacking rule 1's auto-dismiss. Cross-ref to §6.8 priority 100 added. |
| **R3 P1 security**: env-var trust hardening | r3-manager | **YES** — §8.4 trust-contract bullet 4 | Single-source-of-truth: only `resolveLegacyDir()` reads `process.env.CCSM_LEGACY_USERDATA_DIR`; downstream uses validated `legacyDir`. Unit test asserts single read. |
| **R3 P1 reliability**: post-rollback /healthz validation gate | r3-manager | **YES** — §8.7 added bullet | Reuses frag-6-7 §6.4 step 7 health gate; daemon-spawn-failure modal (not migration modal) surfaces if post-rollback boot fails health. Migration sub-system's only contribution is to re-run §8.3. |

**Data-loss risk**: **NO** — every identified data-loss failure mode
is either prevented by structural fix (corruption-as-success closed by
`.backup()`; partial-write closed by step 1a; lockfile-before-step-1a
closes the round-3 in-progress-migration race; user-skip-after-disk-full
flagged for re-offer) or surfaced via blocking modal with non-default
typed-confirm. Round-2 ux report independently verified frag-8 closes
the r1 MUST-1 data-loss concern; round-3 reliability confirms P0-R4
fully closed by lockfile ordering.

**Net plan delta change**: +6h (12h → 18h). Round-2 added +4h
(security/reliability/UX P0); round-3 added +2h (OS-native resolver +
lockfile-ordering test + aggregate-cap test).
