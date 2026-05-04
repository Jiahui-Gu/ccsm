# SettingsService + DraftService Storage Migration Design (Task #337)

**Branch**: `spec/337-settings-storage` (off `working`)
**Date**: 2026-05-04
**Scope**: Research + design only. NO code change. Defines (a) the SQLite
storage shape that backs `SettingsService.{GetSettings,UpdateSettings}` and
`DraftService.{GetDraft,UpdateDraft}`, (b) the migration file naming + lock
SHA workflow needed to land it, (c) the SQL ↔ RPC mapping, (d) how this
unblocks the renderer-side localStorage cutover (#303), and (e) the
acceptance points to extend `daemon-boot-end-to-end.spec.ts` with.
**Out-of-scope**: writing the migration SQL, writing the handlers, editing
renderer code, TaskCreate. Those land in follow-up implementation tasks
once this spec is reviewed.

**Parent epic**: #228 (RPC stub gap audit). Sub-task #9 of the audit's
"Proposed sub-tasks" list.

**Related**:
- `docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md` §"Proposed sub-tasks" #9
- `~/.claude/plans/logical-swinging-brook.md` Wave 3 §6.7 (#228 epic)
- `packages/proto/src/ccsm/v1/settings.proto`
- `packages/proto/src/ccsm/v1/draft.proto`
- `packages/daemon/src/db/migrations/001_initial.sql`
- `packages/daemon/src/db/migrations/runner.ts`
- `packages/daemon/src/db/locked.ts`
- Renderer transitional modules tagged "audit #228 sub-task 9":
  `src/stores/persist.ts`, `src/stores/drafts.ts`,
  `src/components/settings/{AppearancePane,NotificationsPane,UpdatesPane}.tsx`

---

## 1. Audit correction (load-bearing fact)

The #228 audit notes (line "SettingsService and DraftService both depend
on a daemon SQLite settings table … `packages/daemon/src/sqlite/` exists;
a quick grep shows it has no `settings`/`draft` tables yet") inspected
the wrong directory. The migrations live under
`packages/daemon/src/db/migrations/`, not `packages/daemon/src/sqlite/`
(the latter only holds the `WriteCoalescer`). The actual `settings` table
is **already created by `001_initial.sql` (lines 109-114)** and is
FOREVER-STABLE per ch07 §3 + §4:

```sql
CREATE TABLE settings (
  scope TEXT NOT NULL,        -- 'global' in v0.3; 'principal:<key>' in v0.4+
  key   TEXT NOT NULL,
  value TEXT NOT NULL,        -- JSON-encoded; readers parse per key
  PRIMARY KEY (scope, key)
);
```

This is consistent with `draft.proto` line 8: *"Daemon stores drafts in
the `app_state`-style settings table under key `draft:<session_id>` for
v0.3 simplicity"*. **No new migration file is required for v0.3 ship of
SettingsService + DraftService.** The 001 schema was authored with both
services in mind and is sufficient.

This spec therefore does NOT scope `002_*.sql`. It scopes:
1. The `(scope, key, value)` row mapping for every `Settings` proto
   field and for drafts.
2. The runtime read/write path through the existing migration runner.
3. The conditions under which a `002_*.sql` would be required *(none in
   v0.3; documented for v0.4 forward compatibility)*.

---

## 2. Storage shape: key/value, NOT columnar

### 2.1 Why key/value

The `(scope, key, value)` schema is already locked. Even if we were
designing fresh, key/value is the right call for v0.3:

- `settings.proto` `Settings` already mixes typed scalars
  (`detected_claude_default_model`, `user_home_path`, `locale`,
  `sentry_enabled`) with a `map<string, string> ui_prefs` whose keys are
  open-ended (`appearance.theme`, `composer.fontSizePx`, etc.). A
  columnar table would need a column for every typed field PLUS a
  sidecar key/value table for `ui_prefs` — strictly worse than one
  uniform table.
- v0.4 adds per-principal scope additively (`scope = 'principal:<key>'`)
  with NO schema change. A columnar table would need either a `scope`
  column on every row (= same key/value shape with extra column noise)
  or a separate per-principal table (= duplicated migrations on every
  field add).
- `UpdateSettings` is partial-by-field-presence (settings.proto F7).
  Key/value rows naturally express "only the fields the client touched
  changed"; a columnar table would need either per-column UPDATEs in
  one transaction or a hand-rolled diff against the current row.

### 2.2 Row layout (canonical key list, v0.3)

`scope` is always the literal string `'global'` in v0.3. The RPC layer
rejects any other scope (`SettingsScope.SETTINGS_SCOPE_PRINCIPAL` returns
`InvalidArgument` per settings.proto line 35). v0.4 will write
`'principal:local-user:1000'` etc. additively.

`value` is **always JSON-encoded**, even for scalars. Readers parse per
key. Rationale: a `value TEXT` column with mixed JSON / raw forms is a
classic source of "did someone JSON-stringify a string twice" bugs;
keeping the column 100% JSON gives a single uniform parse path and
matches the proto-to-storage codec discipline used elsewhere
(`env_json` / `claude_args_json` in the `sessions` table).

| `key` | proto field | JSON value shape | Notes |
|---|---|---|---|
| `default_geometry` | `Settings.default_geometry` (PtyGeometry) | `{"cols":N,"rows":N}` (omitted if presence bit unset) | Absence of row = use proto default. |
| `crash_retention` | `Settings.crash_retention` (CrashRetention) | `{"max_entries":N,"max_age_days":N}` | Daemon caps `max_entries` at 10000 + `max_age_days` at 90 BEFORE write (settings.proto line 119). Applied at write-time, not read-time, so DB state never holds an out-of-range value. |
| `detected_claude_default_model` | same | `"claude-3-5-sonnet-20241022"` (JSON string) or `""` | Daemon-derived; clients cannot UpdateSettings this — see §6. |
| `user_home_path` | same | `"/home/jiahui"` (JSON string) | Daemon-derived; clients cannot UpdateSettings. |
| `locale` | same | `"en-US"` (JSON string) | Client may UpdateSettings (user override). |
| `sentry_enabled` | same | `true` / `false` (JSON bool) | Default `true` if row absent. |
| `ui_prefs.<dotted.path>` | `Settings.ui_prefs[k]` map entry | already-JSON-string value verbatim (the proto field type is already `string`; daemon does NOT re-encode) | One row per map entry. e.g. key `ui_prefs.appearance.theme` value `"\"dark\""`. |
| `draft:<session_id>` | DraftService payload | `{"text":"…","updated_unix_ms":N}` | Empty `text` in `UpdateDraft` DELETEs the row (draft.proto line 31). |

The `ui_prefs.<...>` key prefix is the mechanical separator that lets the
GetSettings handler reconstruct the proto `map<string, string>` field by
filtering rows whose `key` starts with `ui_prefs.`. The dot after the
prefix is the boundary; reserved prefixes (current and forward) are
listed in §3.4.

### 2.3 Why JSON-wrap even simple strings

Two reasons:
1. **Type roundtrip.** `JSON.parse('"en-US"')` → string; `JSON.parse('null')`
   → null; `JSON.parse('42')` → number. Without the wrap we cannot
   distinguish `value="null"` (the literal string) from absent. Cheap
   insurance.
2. **`ui_prefs` consistency.** `Settings.ui_prefs[k]` values are
   *already* documented as "JSON-encoded strings (parsed per documented
   key)" by the proto comment. Storing all settings rows JSON-encoded
   gives one rule for the whole table, not "JSON for ui_prefs, raw for
   typed scalars".

### 2.4 Reserved key namespace prefixes

For forward compatibility the following key prefixes are reserved by
this spec; new RPCs / new domains MUST claim a prefix here before
landing rows that use them:

| prefix | owner | shape |
|---|---|---|
| `ui_prefs.` | SettingsService.ui_prefs map | one row per map entry |
| `draft:` | DraftService | one row per session; key = `draft:<sid>` |
| `crash_retention` | Settings.crash_retention | exactly one row |
| `default_geometry` | Settings.default_geometry | exactly one row |
| `detected_claude_default_model` | Settings (daemon-derived) | exactly one row |
| `user_home_path` | Settings (daemon-derived) | exactly one row |
| `locale` | Settings | exactly one row |
| `sentry_enabled` | Settings | exactly one row |

Anything outside this list at boot is logged and ignored (forward-tolerant
read; readers must not throw on unknown keys, mirroring proto3 unknown-field
semantics).

---

## 3. Migration files: naming + lock SHA workflow

### 3.1 v0.3 — no new file

As established in §1, the `settings` table already exists in
`001_initial.sql`. The implementation tasks for SettingsService +
DraftService land **handler + wiring code only**, not a new migration.

### 3.2 If a future change *did* require a migration

For posterity (and to anchor the rules for v0.4+):

- **File location**: `packages/daemon/src/db/migrations/<NNN>_<slug>.sql`
  where `<NNN>` is the next 3-digit version after the highest entry in
  `MIGRATION_LOCKS`. v0.3 ship freezes `001` forever; the next file is
  `002_*.sql`.
- **Forward-only**. No down migrations. A "fix" to a shipped migration
  is always a NEW file with a new version (locked.ts comment block,
  lines 27-29).
- **Lock entry**: append to `MIGRATION_HASHES` and `MIGRATION_LOCKS` in
  `packages/daemon/src/db/locked.ts`. Single-line literal-pair form is
  load-bearing (regex consumed by `tools/check-migration-locks.sh` AND
  by `packages/daemon/test/db/migration-lock.spec.ts` — locked.ts lines
  47-51).
- **SHA computation**: lowercase hex SHA-256 of file bytes including the
  trailing newline. NO line-ending normalization (locked.ts lines 36-37).
  This is the OPPOSITE convention from `tools/check-spec-code-lock.sh`
  (which does normalize to LF for cross-platform stability) — different
  tools, different sources of truth, intentional. Migration files are
  text-mode-safe in git (`*.sql` is treated as text but the lock checker
  fetches the working-tree bytes after smudge, so platform CRLF could in
  principle differ — mitigation is that the sole consumer of a migration
  file post-build is the runner reading the bundled bytes, which on a
  given host are stable; the lock detects bundle tampering on that host's
  filesystem). For v0.4+ migrations, authors should `.gitattributes`-pin
  the new file to `text eol=lf` to remove ambiguity.
- **Release-body cross-check**: `tools/check-migration-locks.sh` reads
  the v0.3.0 GitHub release body's "### Migration locks" section and
  verifies every recorded `(filename → sha256)` pair against current
  `HEAD`. The script exits 0 silently while the v0.3.0 tag does not yet
  exist (script lines 53-58). After the tag, every PR runs it.

### 3.3 Why no `002_*.sql` in v0.3

The 001 schema was authored knowing both SettingsService and DraftService
would land later (settings table comments lines 104-108 spell out
`scope = 'global'` for v0.3 / `scope = 'principal:<key>'` for v0.4;
draft.proto line 8 names the table). Splitting the schema across multiple
v0.3-vintage files would have been gratuitous churn. v0.3 ships ONE
migration file forever (001).

### 3.4 When a `002_*.sql` would become necessary later

For reviewer reference, the bar is:

- A new column is required on an existing v0.3-vintage row (e.g.
  per-row TTL on settings rows). Today's schema has none of these
  pressures.
- Performance demands a dedicated `drafts` table (e.g. cursor-paged
  draft history). draft.proto line 12 explicitly leaves this open
  ("a dedicated table can be added additively in v0.4 if perf demands").
  Until then, drafts ride on `settings` with key prefix `draft:`.
- A new top-level domain that does not fit the key/value shape (e.g. a
  binary blob too large for the value column to comfortably hold).
  Crash log + pty deltas already have their own tables for this reason;
  Settings + Drafts do not.

None of these apply for the v0.3 ship of SettingsService /
DraftService. **No `002_*.sql` lands as part of this spec's
follow-up implementation.**

---

## 4. RPC ↔ SQL mapping

The handler module proposed for the implementation task lives at
`packages/daemon/src/rpc/settings/` (new directory; new files
`get-settings.ts`, `update-settings.ts`, `register.ts`) and a sibling
`packages/daemon/src/rpc/draft/`. Each handler is a single Connect
adapter wrapping the SQL below. Handlers MUST go through the daemon's
existing `SqliteDatabase` handle from `openDatabase()` (T5.1) — they do
NOT open their own connection.

### 4.1 SettingsService.GetSettings

```sql
SELECT key, value FROM settings WHERE scope = 'global';
```

Handler post-processing:
1. Initialize an empty `Settings` proto.
2. For each row, dispatch on `key` prefix:
   - `ui_prefs.<rest>` → `settings.ui_prefs[<rest>] = value` (the row
     `value` is the already-JSON-encoded string per §2.2 — copied
     verbatim, since `Settings.ui_prefs` proto field type is
     `map<string,string>` and the documented contract is JSON strings).
   - `draft:*` → SKIP (drafts are owned by DraftService, not exposed
     via Settings).
   - Known typed key (`default_geometry`, `crash_retention`,
     `detected_claude_default_model`, `user_home_path`, `locale`,
     `sentry_enabled`) → `JSON.parse(value)` then assign to the
     corresponding proto field. Use `setOptionalXxx(...)` helpers so
     the proto3 presence bit fires.
   - Unknown key → log at debug level, ignore (forward-tolerant per §2.4).
3. Daemon-derived fields (`detected_claude_default_model`,
   `user_home_path`) are READ from the DB row if present, but FRESH on
   every GetSettings call: the boot path writes them at startup (§5)
   and any UpdateSettings that tries to set them is rejected with
   `InvalidArgument` (§4.2). This keeps the storage shape uniform
   without giving clients a path to spoof daemon-derived state.

`scope` parameter handling: `SETTINGS_SCOPE_UNSPECIFIED` / `GLOBAL` →
proceed; `SETTINGS_SCOPE_PRINCIPAL` → return `Code.InvalidArgument`
(matches proto comment line 35).

### 4.2 SettingsService.UpdateSettings

Partial-update by field presence (settings.proto F7). For each `optional`
field in the request's `Settings` whose presence bit is SET:

- Daemon-derived fields (`detected_claude_default_model`,
  `user_home_path`) → return `Code.InvalidArgument` with message
  `"<field> is daemon-derived and cannot be set via UpdateSettings"`.
- All other typed fields → cap-and-clamp (e.g.
  `crash_retention.max_entries` capped at 10000 per settings.proto line
  119), then UPSERT:
  ```sql
  INSERT INTO settings (scope, key, value)
  VALUES ('global', :key, :json_value)
  ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value;
  ```
- `ui_prefs` map: ONE upsert per map entry passed by the client. To
  delete a `ui_prefs` entry the client sets the value to the empty
  string `""`; daemon DELETEs that row rather than upserting `""`. (This
  matches the documented `ui_prefs` semantic — empty string = "client
  asked to forget this key". Drafts use the same convention; see §4.4.)
- All upserts in ONE `db.transaction(...)` (BEGIN IMMEDIATE) so a
  partial failure rolls back. Better-sqlite3's `txn.immediate(...)` is
  the canonical primitive (already used by `WriteCoalescer.flushBatch`).

After the transaction, the handler runs the §4.1 read path on the same
connection and returns the full post-merge `Settings` (mandated by
settings.proto F7: *"Daemon MUST round-trip the post-merge `Settings`
in the response so the client sees the authoritative resolved view"*).

### 4.3 DraftService.GetDraft

```sql
SELECT value FROM settings WHERE scope = 'global' AND key = 'draft:' || :session_id;
```

Handler:
- Row absent → return `GetDraftResponse{ text: "", updated_unix_ms: 0 }`
  (draft.proto comments line 18-19).
- Row present → `JSON.parse(value)` → `{text, updated_unix_ms}` →
  serialize to response.
- Peer-cred check: handler MUST verify the calling principal owns
  `session_id` (`SELECT owner_id FROM sessions WHERE id = ?` then
  compare to `ctx.principal`). Return `Code.PermissionDenied` if not
  the owner. draft.proto lines 14-16 require this. **This check is
  load-bearing for multi-principal v0.4** — it is NOT optional in v0.3
  even though only one principal exists; landing it now closes the
  TOCTOU window before v0.4 introduces multiple principals.

### 4.4 DraftService.UpdateDraft

```sql
-- empty text => delete
DELETE FROM settings WHERE scope='global' AND key='draft:' || :session_id;
-- non-empty text => upsert
INSERT INTO settings (scope, key, value)
VALUES ('global', 'draft:' || :session_id, :json_value)
ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value;
```

Handler:
- Same peer-cred ownership check as §4.3.
- `text === ""` → DELETE branch (draft.proto line 31).
- Otherwise → set `updated_unix_ms = Date.now()`, JSON-encode
  `{text, updated_unix_ms}`, UPSERT.
- One transaction; respond with `UpdateDraftResponse{updated_unix_ms}`.

### 4.5 Coalescer / WAL interaction

These handlers do NOT go through `WriteCoalescer`. Coalescer is for
high-volume per-session `pty_delta` / `pty_snapshot` writes (16 ms tick
batching + 8 MiB cap). Settings/Draft writes are user-driven, low-volume
(typically <1 Hz), and need synchronous round-trip semantics — the
client expects the post-write `Settings` in the same response. Going
through coalescer would break that contract.

The handlers run on the daemon main thread directly against the shared
`SqliteDatabase` handle. WAL discipline (T5.6) covers them automatically:
the connection is in WAL mode, IMMEDIATE transactions serialize cleanly
against the coalescer's IMMEDIATE transactions on the same connection.
SQLite's writer-lock semantics (one writer, multiple readers, NORMAL sync)
make this a non-issue — no extra coordination required.

---

## 5. Boot-time daemon-derived field population

`detected_claude_default_model` and `user_home_path` are populated by the
daemon's boot path, NOT by the client. The implementation task lands
this as part of the SettingsService wiring:

- After migrations run and BEFORE `runStartup.lock.ts` `assertWired(...)`
  fires, the boot path:
  1. Reads `os.homedir()` (the daemon process's own home, NOT a
     client's — daemon and client may be different OS users in v0.4 per
     settings.proto line 95). UPSERTs `user_home_path` row.
  2. Reads `~/.claude/settings.json` if present, extracts the `model`
     field (string, may be missing → empty string per settings.proto
     line 87). UPSERTs `detected_claude_default_model` row.
- Both writes go through the same `INSERT … ON CONFLICT … DO UPDATE`
  path the handler uses (§4.2), in a single boot transaction.
- If `~/.claude/settings.json` parse fails, the daemon writes the empty
  string and emits a `crash_log` row at source `settings_boot_parse`
  (open string set per chapter 04 §5). It does NOT abort boot.

This is forward-safe: the boot writes happen every boot; they do not
require a migration (they are just rows in an existing table).

---

## 6. Relationship to #303 (renderer localStorage cutover)

#303 tracks the dual-write split: every SettingsService-shaped value
currently lives in renderer `localStorage` (transitional, Wave 0e —
#289 / #297 / #299 / #300 — see headers in `src/stores/persist.ts`,
`src/stores/drafts.ts`, the three `src/components/settings/*Pane.tsx`
files). The transitional comments all say variants of *"When
SettingsService RPC ships (audit #228 sub-task 9), this module re-cuts
to daemon RPC."* That is this task's downstream.

### 6.1 Cutover sequence (post-this-spec)

1. **Implementation tasks land** (out-of-scope here): one or two PRs
   that wire `registerSettingsService` + `registerDraftService` against
   the existing `settings` table per §4. Daemon side ONLY. localStorage
   keeps working untouched.
2. **#303 cutover PR(s)** flip each renderer module from `localStorage`
   to a Connect call against the local daemon transport bridge. Per
   module:
   - `src/stores/persist.ts` → `Settings.ui_prefs.<...>` rows
     (e.g. `ui_prefs.theme`, `ui_prefs.fontSizePx`,
     `ui_prefs.sidebarWidth`, `ui_prefs.activeId`).
     The persist write debounce (250 ms) becomes an `UpdateSettings`
     debounce; the partial-update semantics (settings.proto F7) mean
     each debounce fires only the fields that changed.
   - `src/stores/drafts.ts` → `DraftService.UpdateDraft` per session.
     The localStorage-keyed `STATE_KEY` JSON blob fans out into one
     row per session via `key='draft:<sid>'`.
   - `src/components/settings/AppearancePane.tsx` (`closeAction`),
     `NotificationsPane.tsx` (`notifyEnabled`),
     `UpdatesPane.tsx` (`crashReportingOptOut`) → corresponding
     `ui_prefs.*` keys (or `sentry_enabled` for the Sentry toggle —
     that one has a typed proto field, not a `ui_prefs` entry).
3. **localStorage keys removed** in the same cutover PRs (or a
   follow-up sweep) to avoid stale-data ambiguity.

### 6.2 Why renderer needs the Settings rows present at first GetSettings

When the renderer first boots after cutover it calls `GetSettings`
expecting either the user's prior values or proto defaults. Three
possibilities exist:

- **Fresh install**: no rows yet → `GetSettings` returns a `Settings`
  with no `optional` fields set + an empty `ui_prefs` map. Renderer
  applies its own defaults. Correct.
- **Upgrade from v0.2**: per v0.3 ship goal "treat as new software, no
  users" (`~/.claude/plans/logical-swinging-brook.md` §1.2 + ch07
  §4.5 deletion in Wave 0a / #212), there is no v0.2 user data to
  migrate. localStorage in the renderer is the only previous data
  store, and it's local to a single device's Electron install. Per the
  v0.3 ship intent (no users), we accept that the cutover *loses* any
  values a tester typed into localStorage during Wave 0e. See §8.
- **Upgrade across daemon restarts within v0.3**: rows are durable in
  SQLite; user sees their settings restored. Correct.

### 6.3 Cutover atomicity guarantee

Each #303 cutover PR MUST land in this order to avoid a window where
the renderer dual-writes inconsistent state:
1. Delete the localStorage code path entirely.
2. Replace with the Connect call.
3. Update tests that asserted localStorage behavior to assert the new
   RPC path.

NO dual-write transitional shim. The renderer either reads/writes
localStorage OR it reads/writes daemon — never both for the same
key in the same release. (This matches the wave-locked discipline in
`feedback_wave_ordering_discipline.md`: an in-place edit to a renderer
module is wave-locked, not forward-safe; cutover PRs serialize.)

---

## 7. Acceptance: daemon-boot-end-to-end.spec.ts extensions

`apps/daemon/test/integration/daemon-boot-end-to-end.spec.ts` (#208)
extends per the rolling rule (#225, plan §6.6: every new wire-up PR
adds an assertion). The implementation PR for this spec MUST add the
following assertions:

1. **Settings handler is wired**: `SettingsService.GetSettings` does
   NOT return `Code.Unimplemented`. Returns a `Settings` with the
   daemon-derived `user_home_path` populated (proves §5 boot writes
   ran).
2. **Settings round-trip**: `UpdateSettings` with one `ui_prefs`
   entry, then `GetSettings`, returns the updated value in the
   response's `ui_prefs` map.
3. **Settings partial-update presence semantics**: `UpdateSettings`
   with `crash_retention.max_entries = 0` AND its presence bit set
   actually writes 0 (does not get treated as "field unset").
   Subsequent `GetSettings` returns `crash_retention.max_entries == 0`
   with the presence bit set.
4. **Settings rejects PRINCIPAL scope**: `GetSettings(scope=PRINCIPAL)`
   returns `Code.InvalidArgument`.
5. **Settings rejects daemon-derived field write**: `UpdateSettings`
   trying to set `user_home_path` returns `Code.InvalidArgument`.
6. **Draft handler is wired**: `DraftService.GetDraft` for a known
   session does NOT return `Code.Unimplemented`. Empty session →
   `text == ""` and `updated_unix_ms == 0`.
7. **Draft round-trip + DELETE**: `UpdateDraft(text="hello")` →
   `GetDraft` returns `"hello"`. Then `UpdateDraft(text="")` →
   `GetDraft` returns `text == "" && updated_unix_ms == 0` (row
   actually removed; verify via direct SQL probe in the test).
8. **Draft peer-cred enforcement**: `GetDraft` for a session whose
   `owner_id` differs from the caller's principal returns
   `Code.PermissionDenied`. (This requires the integration test to
   construct a second principal context; if that infrastructure does
   not yet exist, the test is gated behind an existing helper or
   added as a sibling test in the same PR — NOT skipped.)
9. **Lock self-check still passes**: `MIGRATION_LOCKS` still resolves
   to exactly one entry (001) and `runMigrations()` returns
   `applied: []` after first boot's table-already-there state.
   (Defensive — proves the implementation did NOT accidentally
   introduce a `002_*.sql`.)

The lock-related Wave 1 ship gates (a/b/c/d in
`docs/superpowers/specs/2026-05-03-v03-daemon-split.lock.json`) are
unaffected — this work touches none of the locked files. PRs running
`tools/check-spec-code-lock.sh` continue to pass without modification.

---

## 8. Risks

### 8.1 v0.2 user data migration (decided: NONE)

v0.2 wrote settings to renderer-side `localStorage` (legacy) plus IPC
helpers. v0.3 plan (`~/.claude/plans/logical-swinging-brook.md` §1.2,
ship intent decision #2) treats v0.3 as "new software, no users";
ch07 §4.5 v0.2 migration spec section was deleted in Wave 0a (#212).
**Decision: no migration runs.** Any state written to v0.2
localStorage is lost on cutover. This is a one-time cost paid by the
small set of internal testers and is explicitly accepted.

For the avoidance of doubt: this means we do NOT add a "read
localStorage on first daemon boot and import into settings table"
helper. That code path would (a) never be exercised by real users
(they don't exist), (b) require renderer→daemon plumbing for a
one-shot import, (c) need to be removed in v0.4 — net negative.

### 8.2 Wave 0e localStorage data loss during cutover

Internal testers using #289/#297/#299/#300 builds have settings in
localStorage. After #303 cutover, those values vanish. Mitigation:
none required given §8.1; a release-note entry for the cutover PR is
sufficient. Testers who care can manually re-enter their preferences
post-cutover.

### 8.3 SQL injection in draft key (non-issue, documented)

`DraftService` keys use `'draft:' || :session_id`. `session_id` comes
off the wire and is concatenated into a SQL string-literal-shaped key
via parameter binding (NOT string interpolation). Better-sqlite3
parameter binding handles escaping; the `||` happens server-side via
SQLite's string operator on the bound parameter, not via JS string
concat. There is no injection vector. The handler nonetheless validates
that `session_id` matches the ULID format `[0-9A-Z]{26}` before the
query runs — this is defense-in-depth, not a fix for a real bug.

### 8.4 GetSettings cost on large `ui_prefs` map

`SELECT * FROM settings WHERE scope='global'` is a full-scope scan.
With `(scope, key)` PRIMARY KEY there's an index-scan on the leading
column, so the cost is `O(rows in scope)`. For a typical install
(<100 ui_prefs entries + 6 typed scalars + N draft rows), this is
sub-millisecond. If `ui_prefs` ever grows to thousands of entries the
handler can switch to a key-prefix-targeted query
(`WHERE scope='global' AND key NOT LIKE 'draft:%'`) without a schema
change. Not a v0.3 problem.

### 8.5 Concurrent UpdateSettings races

Two clients (or one client with rapid-fire UpdateSettings) hitting
overlapping `ui_prefs` keys: the IMMEDIATE transactions serialize at
the SQLite layer. Last-write-wins per row, which is the documented
behavior of `UpdateSettings` (no CAS in v0.3). v0.4 may add a `version`
field for OCC; out of scope.

### 8.6 Peer-cred bypass if SessionService.CreateSession is still stubbed

DraftService's ownership check (§4.3) reads `sessions.owner_id`. If
the only sessions in the DB were created by the stub path (no
`owner_id`) the check would always fail. Mitigation: the
implementation task is wave-locked behind #208 (which wires
WatchSessions) and behind the SessionService.CreateSession handler
landing — see audit sub-task 6 — because without real CreateSession,
no rows enter the `sessions` table at all. This is not a v0.3 ship
blocker as long as the DraftService task is dispatched AFTER the
SessionService write-path tasks.

---

## 9. Open questions

1. **`ui_prefs` value semantics — JSON-string-of-anything vs
   typed-per-key.** Proto comment says values are "JSON-encoded strings
   (parsed per documented key)" and "Daemon does NOT validate the value
   shape". Storing them verbatim is simplest. Open: do we want a
   per-key registry (e.g. `appearance.theme: enum["light","dark"]`)
   *anywhere* in the daemon, or is the renderer the sole authority?
   Current spec choice: renderer owns the schema; daemon is a dumb
   key/value store for `ui_prefs`. Confirm before implementation.

2. **Should `detected_claude_default_model` re-read on every
   GetSettings call, or only at boot?** Spec (settings.proto line
   83-86) says "daemon reads at boot and on each GetSettings call".
   Re-reading on every GetSettings adds a sync `fs.readFileSync` to
   the hot read path. Open: do we prefer (a) re-read every call
   matching the proto comment, or (b) re-read at boot + on a
   filesystem-watcher trigger (`fs.watch(~/.claude/settings.json)`)?
   Current spec choice: §5 re-reads at boot only (closer to (b) without
   the watcher). If reviewer wants strict proto-comment compliance,
   bump to (a) — the cost is one stat + tiny file read per GetSettings,
   acceptable. Confirm.

3. **`scope` storage when v0.4 lands principals.** Today every row is
   `scope='global'`. v0.4 will add `scope='principal:<key>'` rows.
   Open: should v0.3 GetSettings refuse to read non-`'global'` rows
   (defensive, matches the proto enum reject), or read them silently?
   Current spec choice: only ever read `'global'` (matches §4.1 SQL).
   This means a forward-incompat downgrade from v0.4 → v0.3 silently
   ignores per-principal rows; the user sees their global defaults.
   Acceptable for v0.3.

4. **DraftService quota.** No per-row size cap on draft `text`. A user
   pasting a 10 MB blob fills `value TEXT` with 10 MB JSON-encoded.
   No SQLite limit hit (TEXT max is 1 GiB), but it's wasteful.
   Open: cap at e.g. 64 KiB? Reject with `Code.InvalidArgument`
   above the cap? Current spec choice: NO cap in v0.3 to avoid
   surprising users mid-typing. Reviewer may want to add one;
   trivially additive later (handler-side check, no schema change).

5. **GetSettings response `effective_scope` echo.** Proto returns
   `effective_scope` (settings.proto line 47). Today this is always
   `SETTINGS_SCOPE_GLOBAL`. Implementation should hardcode that
   constant in the response; no DB read. Confirmed — listed as
   open only because it's a trivia point reviewers might ask about.

6. **Draft prefix collision risk.** Key `draft:<session_id>` shares the
   `settings` table with `ui_prefs.*` keys and typed scalars. If a
   future ui_pref were named literally `draft:foo`, ambiguity. Spec
   §2.4 reserves `draft:` for DraftService — this is documentation,
   not code enforcement. Open: should we add a runtime check at
   UpdateSettings that rejects `ui_prefs.<rest>` if `<rest>` starts
   with `draft:`? Current spec choice: no — `ui_prefs` keys are
   always written through the `ui_prefs.` prefix on the storage row,
   so there's no actual collision (the row would be `ui_prefs.draft:foo`
   not `draft:foo`). The risk is purely cosmetic and resolved by §2.4.

---

## 10. Summary

| Question | Answer |
|---|---|
| New migration file? | NO. `001_initial.sql` already created the `settings` table. |
| Storage shape? | key/value `(scope, key, value)` with JSON-encoded values for everything. |
| Drafts table? | Same `settings` table with `key='draft:<sid>'`. |
| Migration lock workflow if a future change needs one? | new `<NNN>_*.sql`, append entry to `MIGRATION_HASHES` literal-pair line in `locked.ts`, raw SHA256 of file bytes (no normalization), release-body cross-check via `tools/check-migration-locks.sh`. |
| Renderer cutover path (#303)? | post-impl: each Wave-0e localStorage module replaces its `localStorage.{getItem,setItem}` calls with one Connect call; no dual-write shim. |
| v0.2 → v0.3 user data migration? | NONE. v0.3 ships as new software per ship intent. |
| daemon-boot-e2e additions? | 9 new assertions covering wire-up, round-trip, partial-update presence semantics, scope rejection, peer-cred enforcement, and lock self-check stability. |
| Ship-gate lock files affected? | NONE. |
