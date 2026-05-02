# R1 (feature-preservation) review of 07-data-and-state.md

The chapter pins the daemon-side SQLite schema and per-OS state directories. The big feature-preservation gap is that today's user data lives in per-user Electron paths (`app.getPath('userData')`) and includes a key/value `app_state` table that holds prefs, drafts, and other renderer state. The spec invents fresh system-scope paths and a session-centric schema, with no migration story for existing user data and no place for the existing `app_state` keys.

## P0 findings (block ship; user-visible feature drops or breaks)

### P0.1 No place in the daemon SQLite schema for the existing `app_state` key/value rows

**Location**: §3 ("SQLite schema (v0.3 baseline)")
**Current behavior**: `electron/db.ts` defines `CREATE TABLE IF NOT EXISTS app_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)`. Renderer and main both write here via `db:load`/`db:save`. Holds: theme, fontSize, fontSizePx, sidebar width, drafts (per-session), closeAction, notifyEnabled, crashReporting opt-out, user-cwds LRU, updater auto-check, language, sessionTitles state, more.

**Spec behavior**: §3 lists `principals`, `sessions`, `pty_snapshot`, `pty_delta`, `crash_log`, `settings`, `cwd_state`. The `settings` table is `(key, value)` but is described in chapter 04 §6 as the backing store for the typed `Settings` message (3 fields: claude_binary_path, default_geometry, crash_retention).

**Gap**: there is nowhere for theme, drafts, etc. to live in the daemon DB unless the spec stretches `settings` to be a free-form key/value bag. Today these prefs survive Electron uninstall+reinstall (the DB lives in userData which the installer typically doesn't wipe); after the refactor they live in "ephemeral renderer cache" per §2 — silent regression.

**Suggested fix**: either (a) extend the `settings` table to be the explicit replacement for `app_state` and have chapter 04's `SettingsService` carry a generic key/value RPC alongside the typed `Settings` message, OR (b) add a new `app_state` table to §3 mirroring today's schema and add an `AppStateService` to chapter 04.

### P0.2 Silent loss of existing v0.2 user data on upgrade

**Location**: §4 ("Migration story") — covers daemon-internal schema migrations only
**Current behavior**: existing v0.2 user has data at `app.getPath('userData')/ccsm.db` (Windows: `%APPDATA%/ccsm/`, mac: `~/Library/Application Support/ccsm/`, linux: `~/.config/ccsm/`). The `app_state` table inside has the user's accumulated theme/font/drafts/cwds/etc. The session list in renderer hydrates from app_state too (sessions are persisted there as JSON in the current architecture).

**Spec behavior**: spec invents brand-new per-OS paths under `%PROGRAMDATA%` / `/Library/Application Support` / `/var/lib/ccsm` (system scope) and a brand-new `sessions` table. Spec is silent on whether the installer or daemon-on-first-boot copies/converts data from the old per-user path.

**Gap**: First-launch v0.3 finds: empty session list, default theme, default font, no drafts, no recent cwds, no preference history. The user perceives this as data loss. Compounded by the fact that the old data file is still there at the old path (now orphaned and invisible).

**Suggested fix**: add a §4.5 "v0.2 → v0.3 user data migration" subsection. Choose one explicitly:
1. **Migrate**: daemon on first boot detects old `app.getPath('userData')/ccsm.db` (per-OS path table), reads `app_state` rows + sessions, writes to new daemon DB, renames old file to `.migrated-<ts>` so we don't re-import on subsequent boots. Document which keys map to which new tables. This is the user-friendly choice.
2. **Drop with notice**: explicitly accept the loss; installer post-script + first-launch dialog "Your previous ccsm data could not be carried over because the storage location moved to a system-wide service. Old data preserved at <path>." Document a migration script users can run manually.
3. **Hybrid**: migrate sessions and crash log (high value), drop UI prefs (low value, user re-picks once).

Silence = silent data loss = P0.

### P0.3 Per-user data isolation lost when daemon is system-scope

**Location**: §2 (state directory layout)
**Current behavior**: today's app stores per-user under `app.getPath('userData')`. Two OS users on the same machine each have their own ccsm sessions, theme, prefs, crash log. Standard OS file-permission isolation.

**Spec behavior**: daemon writes to system-wide paths (mode `0700` for daemon's service account). Sessions are per-principal via `owner_id`, but settings and crash_log are global (chapter 05 §5: "settings are global to the daemon install" in v0.3). On Mac/Linux family machine, all OS users share theme + prefs + see each other's crash entries.

**Gap**: A two-user household / shared dev box / corporate workstation regresses from "private per-user state" to "shared global state minus session list". Privacy regression for crash_log specifically (could leak file paths or stack frames containing user names).

**Suggested fix**: either acknowledge in `01-overview.md` §2 non-goals (and warn users with multiple OS accounts), or scope `settings` and `crash_log` per-principal from day one (chapter 05 §5 already calls this out for v0.4 — pull it into v0.3 if multi-user is supported today).

## P1 findings (must-fix; UX regression or silent migration)

### P1.1 Drafts (per-session composer text) have no daemon home

**Location**: §3 (no `drafts` table); chapter 08 (no mapping)
**Current behavior**: `src/stores/drafts.ts` saves draft text per-session via `window.ccsm.saveState('draft:<sid>', text)` on every keystroke; restored on Electron restart so a long prompt isn't lost.
**Spec behavior**: §2 mentions renderer-side cache "deletable any time". No `drafts` table in §3.
**Gap**: Drafts silently move from "survive Electron restart" semantics to "lost on Electron restart" if relegated to renderer-only `localStorage`.
**Suggested fix**: add `drafts (session_id TEXT PRIMARY KEY, text TEXT, updated_ms INTEGER)` to §3 and a `DraftService` (or extend SessionService) to chapter 04. Bonus: v0.4 web/iOS clients pick up where the user left off across devices.

### P1.2 sessionWatcher state (pending renames, JSONL tail offsets, project-key cache) has no schema

**Location**: §3
**Current behavior**: `electron/sessionWatcher/*` and `electron/sessionTitles/*` carry pending-rename queues and offset state. Today's queue is in-memory only (per file header) which is itself a known limitation.
**Spec behavior**: silence.
**Gap**: When daemon restarts, all pending renames are lost (today: same behavior, but daemon restarts are now expected far more rarely than electron restarts since daemon is a system service running 24/7 — so practical impact is smaller than today's). Still: the daemon now owns the JSONL tail watcher and should persist its offsets so that crash-restart doesn't replay duplicates.
**Suggested fix**: add `pending_renames` and `jsonl_offsets` tables (or document they remain in-memory and explain why that's acceptable).

### P1.3 No backup of `app_state`-equivalent in `VACUUM INTO` export

**Location**: §6 (Backup and recovery)
**Current behavior**: v0.2 has no backup feature, so no regression there. But spec adds one: "User-initiated backup: Settings → Backup → Export runs `VACUUM INTO`."
**Spec behavior**: assumes single DB file is the backup unit. Fine if all user data lives in that file.
**Gap**: tied to P0.1 — if `app_state` equivalent isn't in the daemon DB, the backup misses prefs.
**Suggested fix**: resolve P0.1; restate here that the backup includes the renamed `app_state`.

## P2 findings (defer)

### P2.1 Linux uses `/var/lib/ccsm/` (FHS) explicitly rejecting XDG

Author noted this in `15-zero-rework-audit.md` §4.8 as a review-attention item. Acceptable: daemon is system-level, no logged-in user. P2 — confirm in audit.

### P2.2 `crash-raw.ndjson` truncate-on-import not crash-safe

If daemon crashes between "import to crash_log" and "truncate file", entries are imported twice (key collision on `id` so the second insert is ignored — fine, ULID is unique). Self-healing in practice; flagged for completeness.
