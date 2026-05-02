# R0 (zero-rework) review of 07-data-and-state.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 `crash_log` schema lacks `owner_id`; v0.4 add-with-NULL leaks across principals

**Location**: `07-data-and-state.md` §3 (`crash_log` table); cross-ref `05-session-and-principal.md` §5 and `15-zero-rework-audit.md` row "[09 §1]"
**Issue**: `crash_log` ships without an `owner_id` column. Audit chapter declares the v0.4 add as "additive (default NULL = global)". When v0.4 migrates: existing v0.3 rows (all created under `local-user:<X>`) become `NULL = "global"`, meaning every cf-access principal that authenticates in v0.4 sees the local-user's historical crash details (file paths, stack traces with usernames, etc.). This is both a **privacy regression** AND an RPC semantic change (`GetCrashLog` returns different data for the same caller depending on v0.3-vs-v0.4 daemon).
**Why P0**: UNACCEPTABLE pattern "Any v0.3 SQLite schema column whose semantics differ once cf-access principals exist".
**Suggested fix**: In `001_initial.sql` ship `crash_log.owner_id TEXT NOT NULL`. Set to `principalKey(ctx.principal)` for caller-attributed sources and to a literal sentinel `"daemon-self"` for daemon-internal sources (`sqlite_open`, `migration`, `listener_bind`, `watchdog_miss`). Rows from `claude_exit`/`pty_eof`/`worker_exit`/`sqlite_op`: use the owning session's `owner_id`. v0.4 just adds new principal-kind values to this column; no migration, no semantic shift.

### P0.2 `settings` table is a plain `(key, value)` global store with no scope discriminator

**Location**: `07-data-and-state.md` §3 (`settings` table)
**Issue**: `CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)` is a global key-value store. The audit row "[05 §5]" says v0.4 adds a *new* `settings_per_principal` table — additive. But the existing `settings` table's KEYS (e.g., `claude_binary_path`, `default_geometry`) are conceptually per-principal in v0.4 (different cf-access users may want different defaults). v0.4 will face: (a) leave `settings` global, add `settings_per_principal` with overlap semantics — code paths must consult both tables, with a precedence rule that didn't exist in v0.3 (semantic shift); OR (b) migrate keys from `settings` to `settings_per_principal` keyed on a synthetic `local-user:<self>` — UNACCEPTABLE column semantic change.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 SQLite schema column whose semantics differ once cf-access principals exist".
**Suggested fix**: In v0.3 ship `settings(scope TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY(scope, key))` where `scope` is `principalKey(...)` OR the literal `"global"`. v0.3 daemon writes only `scope = "global"` (and ignores other values on read). v0.4 daemon writes `scope = principalKey(p)` for principal-scoped keys. No new table, no precedence rule reshuffle, no semantic shift.

### P0.3 `principals` table missing v0.4-needed `aliases` linkage table

**Location**: `07-data-and-state.md` §3 (`principals` table)
**Issue**: The `principals` table has `(id, kind, display_name, first_seen_ms, last_seen_ms)`. There is no provision for a single human being represented by multiple `principalKey`s (e.g., `local-user:S-1-5-...` AND `cf-access:user@example.com` for the same person, see `05-session-and-principal.R0.review.md` P0.3). v0.4 will need this and adding it requires either a new table (additive — fine) OR rewriting every `WHERE owner_id = ?` to `WHERE owner_id IN (caller_canonical_id, alias1, alias2, ...)`. Without the structural placeholder in v0.3, every consumer query has to be edited in v0.4.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 daemon-side state keyed by something Electron-specific that doesn't generalize". The `local-user` SID is Electron-specific from the v0.4 web/iOS client's POV.
**Suggested fix**: Add to `001_initial.sql`:
```sql
CREATE TABLE principal_aliases (
  canonical_id TEXT NOT NULL REFERENCES principals(id),
  alias_id TEXT NOT NULL UNIQUE,
  added_ms INTEGER NOT NULL,
  PRIMARY KEY (canonical_id, alias_id)
);
```
v0.3 never writes here (table stays empty). All principal-filtering queries are written in v0.3 as `WHERE owner_id IN (SELECT id FROM principals WHERE id = ? UNION SELECT alias_id FROM principal_aliases WHERE canonical_id = ?)`. With no aliases, the union degenerates to single-row equality; no perf hit. v0.4 populates the table.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 Linux `/run/ccsm/listener-a.json` is volatile (cleared on reboot before daemon binds)

**Location**: `07-data-and-state.md` §2 (Linux row)
**Issue**: `/run/ccsm/` is a tmpfs that systemd creates on demand via `RuntimeDirectory=` in the unit file (good). But chapter 02 §2.3 doesn't mention `RuntimeDirectory=ccsm` in the systemd directives list (only `Type=notify`, `Restart=on-failure`, `RestartSec=5s`, `WatchdogSec=30s`). If the directive is missing, the daemon must `mkdir /run/ccsm/` at boot; on systems with strict tmpfs ACLs this fails or creates with wrong ownership. v0.4 inherits any path issue.
**Why P1**: Implementation gap; not a wire-shape issue but the spec leaves a system-service detail underspecified.
**Suggested fix**: Add `RuntimeDirectory=ccsm` and `RuntimeDirectoryMode=0750` to the systemd unit's `[Service]` section in chapter 02 §2.3.

### P1.2 SQLite `synchronous = NORMAL` allows up to one-transaction loss on power failure

**Location**: `07-data-and-state.md` §1, §6
**Issue**: §6 says "WAL mode + `synchronous = NORMAL` survives process kill with at most the most recent uncommitted transaction lost." Acceptable for v0.3 single-user. For v0.4 multi-tenant cf-access deployments where one principal's snapshot+delta loss masquerades as another's silent corruption (different humans seeing different states of "the truth"), the trade-off shifts. Not v0.4 rework — v0.4 can flip to `synchronous = FULL` additively as a setting — but the spec should expose the knob now.
**Why P1**: Soft additivity; flag for explicit future-tunability.
**Suggested fix**: Move `synchronous` to a `Settings` field (not just a PRAGMA) so v0.4 can toggle without reshape. Or document explicitly in chapter 15 §3 that pragma values are not contractual.

### P1.3 Migration immutability lock is a SHA256 in source — not enforced by `buf breaking`-style external check

**Location**: `07-data-and-state.md` §4
**Issue**: "A SHA256 of `001_initial.sql` is committed as a constant in `packages/daemon/src/db/migrations/locked.ts`; CI compares." A contributor can update both files in one PR — the lock catches accidental edits but not deliberate ones. v0.4 contributor under deadline pressure could "fix" `001_initial.sql` and update the lock to match. Brief §6 forbids reshape post-ship; this is the v0.3 schema's analog of `buf breaking`.
**Why P1**: Process gap, not architecture.
**Suggested fix**: Make the v0.3 migration SHA256 an external-tag invariant: a CI job fetches `001_initial.sql` from the v0.3 release tag (after tagging) and compares to HEAD; mismatch fails. The in-source `locked.ts` constant is documentary, not authoritative.
