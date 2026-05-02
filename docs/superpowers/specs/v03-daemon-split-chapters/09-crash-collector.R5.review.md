# R5 review — 09-crash-collector.md

## P0

### P0-09-1. Capture source string set diverges between chapters 04, 09, and 05
- Chapter 04 §5 example list: `"uncaughtException" | "unhandledRejection" | "claude_exit" | "pty_eof" | "sqlite_open" | ...`
- Chapter 09 §1 enumerates 11 sources: `uncaughtException, unhandledRejection, claude_exit, claude_signal, pty_eof, sqlite_open, sqlite_op, worker_exit, listener_bind, migration, watchdog_miss`.
- Chapter 05 §7 mentions writing crash_log entry on session restore failure — implies a `claude_spawn` (or similar) source not in chapter 09's list.

The `source` field is documented as an open string set so adding new values is fine, BUT chapter 09 §1 is presented as "exhaustive" and chapter 05's `restore-failure` source is missing. Either:
- (a) add `"session_restore"` / `"claude_spawn"` to chapter 09 §1's list and reuse `claude_exit` for actual exits.
- (b) drop "exhaustive" and document that 09 §1 is non-exhaustive.

P0 because chapter 13 phase 6 acceptance criteria says "All capture sources from [09] §1 wired" — exhaustiveness drives implementation completion.

## P1

### P1-09-1. `crash-raw.ndjson` import-on-boot
§2 says daemon "scans `crash-raw.ndjson`, imports any entries not already in `crash_log` (by id), then truncates the file". 
- What if the file is corrupted (partial line)? Skip line and continue, or fail boot? Pin.
- What if SQLite import fails (disk full)? Pin: don't truncate; retain raw entries.
- File path is `state/crash-raw.ndjson` — relative to state root. Daemon writes the file from `process.on('uncaughtException')` — at that point SIGTERM may be imminent. Need atomic append (`O_APPEND` + single `write()` syscall, < PIPE_BUF). Pin.

### P1-09-2. Watchdog mechanism — Linux only
§6 admits Win/macOS lack equivalent. Spike [watchdog-darwin-approach] is "defer-OK". Chapter 13 phase 11 ship-gate (b) tests SIGKILL of Electron, not daemon hang. So a daemon hang on Win/macOS is undetected pre-ship. Add a residual risk row in chapter 14 §2 (already there indirectly). OK; restate cross-ref here.

### P1-09-3. Vague verbs
- §1 row "warn (v0.3)" / "fatal" — pinned, OK.
- §3 "Pruner runs at boot and every 6 hours" — pinned. Good.
- §5 "renderer-only" — pinned.

### P1-09-4. "Open raw log file" button uses "the `app:open-external` replacement"
Chapter 08 §3 replaces `app:open-external` with `window.open(url, '_blank')` for `https?://` schemes only. `file://` scheme is excluded. Then how does Settings open the raw log file? Either:
- Drop the button.
- Loosen the open-external policy to allow `file://` for daemon-known paths.
- Show the path as text and let user copy/paste.

P1 — current design is internally inconsistent (button doesn't work).

### P1-09-5. `WatchCrashLog` filter
Chapter 05 §5 says crash log is "open to any local-user principal" in v0.3 (no owner_id). ✓ Consistent with chapter 09. Cross-ref OK.

## Scalability hotspots

### S1-09-1. `WatchCrashLog` stream
Multiple Electron windows × 1 watch each → fan-out. With low crash rate this is fine. No cap mentioned. (Same comment as chapter 04 — unify.)

### S1-09-2. `sqlite_op` source rate-limited at "one entry per ~60s per code-class"
Good — explicit cap. ✓

### S1-09-3. Per-source listener registration order
`process.on("uncaughtException")` — Node fires all listeners for the event. If another module also registers, order matters (first-registered runs first). Pin: daemon registers crash collector FIRST, before any other code that may register.

## Markdown hygiene
- §1 table OK.
- §2 JSON example is tagged `json`. Good.
- §6 spike marker uses `>` blockquote — consistent with other chapters.
