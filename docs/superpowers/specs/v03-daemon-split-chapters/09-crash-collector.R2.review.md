# R2 (Security) review — 09-crash-collector

## P0

### P0-09-1 — Crash capture stores PII (paths, env, stderr, PTY tail) without scrubbing; v0.4 will upload "additively" — too late

§1 capture sources record:
- `claude` exit: "last 4 KiB of stderr ring buffer" — claude stderr commonly includes file paths with usernames, MCP server addresses, sometimes API request URLs.
- `pty_eof`: "last 1 KiB of pty output" — verbatim conversation transcript / tool output.
- `sqlite_open`: "path, error code, errno" — discloses install layout, username.
- `uncaughtException`: "stack" — Node stacks include absolute file paths (`/Users/<name>/...`, `C:\Users\<name>\...`).
- `migration`: "error" — may contain row data.

Per R2 brief angle 8: scrubbing MUST happen at capture, not at upload time. The spec does not specify any scrubbing rule. Chapter 15 audit row §10 marks v0.4 upload as **additive** with "capture path unchanged", which **freezes the unscrubbed schema** — once v0.3 ships, every device accumulates 90 days × 10000 entries of unredacted PII. v0.4's uploader cannot retroactively scrub already-stored entries (a shipped capture path must produce wire-stable rows for "additive" to hold).

Spec must mandate now:
- A canonical scrubber applied at capture time: home-dir → `$HOME`, username → `$USER`, env-var values → `<redacted>` for non-allowlisted keys, IPv4/IPv6 addresses → `<ip>`, JWTs / PEM blocks / `sk-*` / `claude-*` token patterns → `<redacted-secret>`.
- A `scrubber_version` column so v0.4 can re-scrub forward (additive new column).
- Define which raw fields are kept vs scrubbed.

### P0-09-2 — `crash_log` open to any local-user principal exposes other users' PII (multi-user Linux)

Cross-ref ch 05 P0-05-2. With `crash_log` not principal-scoped and group `ccsm` containing multiple users (ch 02 §2.3), user A reads stack traces from user B's sessions including B's home dir, B's recently-typed commands, B's API keys if they appeared in stderr/PTY. Independent of P0-09-1, spec must scope crash entries to their originating principal NOW (cheap: add `owner_id` column at `001_initial.sql`; backfill default = NULL = "global daemon-internal" for sources like `sqlite_open` or `migration`).

## P1

### P1-09-1 — `sqlite_op` "sql (redacted)" — redaction algorithm undefined

§1: "sql (redacted)". What does "redacted" mean? Strip parameter values? Strip table/column names too? If redaction strips literals but keeps query shape, fine; if it strips nothing or strips too much, either leaks data or loses debugging value. Spec must define the algorithm (e.g., `prepare`-statement template only, no bound param values).

### P1-09-2 — `crash-raw.ndjson` recovery imports unauthenticated file content (ch 07 P1-07-2 cross-ref)

§2: import on next boot, no integrity check on the file. If an attacker can write to the daemon state dir (compromise of any process running as the service account), they inject crash entries with attacker-chosen `summary`/`detail`/`labels`. Mitigations: HMAC each line with a key derived from a per-install secret; or write the file outside the state root in a more-restricted dir; or accept-but-quarantine — never auto-display imported entries until reviewed.

### P1-09-3 — `WatchCrashLog` server-stream has no rate limit

§4: "server-streams new entries as they land." A misbehaving claude that triggers `unhandledRejection` per byte of output overwhelms the WatchCrashLog stream and the SQLite write coalescer. Rate-limit per source per minute; spec hints at this for `sqlite_op` ("one entry per ~60s per code-class") but should generalise.

## P2

### P2-09-1 — Linux watchdog via `WATCHDOG=1` from main thread; spec doesn't specify what an attacker-induced hang looks like

§6 watchdog detects main-thread hang. If an attacker can force main-thread blocking (e.g., a giant SQLite query, a slow native module call), they can cause the daemon to be killed by systemd repeatedly → recovery loop → DoS. Combined with ch 02 §2.1 "after 2 failures, run no command", a 3-restart-burst kills the daemon for the rest of the boot. Spec should mandate: watchdog hits log a `crash_log` entry **before** raising SIGABRT, AND restart loop has exponential backoff coordinated with ch 02's recovery actions.

### P2-09-2 — Windows / macOS no watchdog → silent hangs unobservable

§6 acknowledges. Threat model implication: attacker-induced hang on win/mac is permanent without user noticing (Electron shows "Reconnecting…" forever per ch 08 §6). Add an Electron-side timeout escalation: after N seconds of `UNAVAILABLE`, surface a hard-error modal directing user to crash log.

### P2-09-3 — Settings UI "Open raw log file" button uses `app:open-external` replacement (`window.open`)

§5 third bullet. `crash-raw.ndjson` is a file path, not an `https://` URL. `window.open('file:///path')` is blocked in Chromium; the button cannot work as specified without falling back to Electron `shell.openPath`, which the migration explicitly forbade (ch 08 §3). Either drop the button or carve out `shell.openPath` as a documented exception to `lint:no-ipc`.
