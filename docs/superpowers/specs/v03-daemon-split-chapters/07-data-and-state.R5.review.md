# R5 review — 07-data-and-state.md

## P0

### P0-07-1. `sessions` table has `should_be_running INTEGER NOT NULL DEFAULT 1` but chapter 05 §7 / chapter 13 phase 2 don't mention it
Chapter 05 §7 says daemon reads "every session row with `state IN (STARTING, RUNNING)`" and respawns. But chapter 07 §3 introduces `should_be_running` column with a different semantic: "0 if user destroyed; 1 if daemon should respawn on boot". The intended behavior is presumably "respawn if `should_be_running = 1` AND state in (STARTING, RUNNING)" — but chapter 05 §7 only checks state, not the new column. **Cross-chapter contradiction**. Either delete `should_be_running` (rely on state — but then `DestroySession` flips state to EXITED and sets `should_be_running` is redundant) or update chapter 05 §7 to read `WHERE should_be_running = 1`. P0 because daemon respawn semantics are direct ship-gate (b) input.

## P1

### P1-07-1. Crash-raw NDJSON path appears in two state-dir tables — naming consistent
chapter 07 §2 + chapter 09 §2 both say `state/crash-raw.ndjson`. Good.

### P1-07-2. macOS state dir `/Library/Application Support/ccsm/` (note space)
Path with literal space. SQL paths and shell scripts (chapter 10 §5.2) need quoting. Verify chapter 10 quoting in `pkgbuild` / `launchctl` invocations — currently chapter 10 §5.2 has `launchctl bootstrap system /Library/LaunchDaemons/com.ccsm.daemon.plist` which is fine (no space in plist path). But state dir path with space appears in chapter 02 / 07 — daemon code must quote. Trivially handled in TS but downstream worker should be reminded. Add note OR pick `/Library/Application Support/Ccsm/` (capital C — Apple convention is to use product name capitalization, but with space). Currently fine but worth flagging.

### P1-07-3. `cwd_state` table — when is it written?
§3 defines the table: "Per-session 'last known cwd' tracker so a session restored after crash restarts in the cwd the user was actually in". **Who writes it?** No RPC writes it. The daemon would need to track `cwd` changes from the PTY (e.g., parsing `cd` shell commands or OSC 7 sequences). Not specified anywhere. Either:
- Pin: "daemon parses OSC 7 (`\e]7;file://...\a`) from PTY output and updates `cwd_state`"
- Or: drop the table from v0.3 (mark v0.4 additive)

Currently the table exists but no chapter writes to it. P1 — dead schema is a downstream landmine.

### P1-07-4. `principals` table is referenced by FK from `sessions.owner_id` 
But who inserts into `principals`? On every Hello? On every CreateSession? Insert-or-update? Not specified. A session create would FK-fail if the principal row doesn't exist. Pin: "before any session-touching write, daemon UPSERTs the principal row keyed by `principalKey(p)`". Otherwise downstream worker's first CreateSession crashes.

### P1-07-5. Migration discipline: SHA256 lock in `locked.ts`
"`packages/daemon/src/db/migrations/locked.ts`" — chapter 11 §2 directory layout has `db/` directory but does not list `locked.ts`. Add to monorepo layout or make it implicit.

### P1-07-6. Vague verbs
- §5 "blocks deltas for that session for the snapshot duration" — duration unbounded. Pin a max snapshot generation time (10 ms target, 100 ms hard) or backlog grows.

### P1-07-7. v0.4 delta line item: "new principals.kind value `cf-access`"
But `principals.kind` is `TEXT`, no CHECK constraint. Adding values isn't a schema change; mention "no migration needed for new kind values" to avoid an unnecessary v0.4 migration.

## Scalability hotspots

### S1-07-1. `pty_delta` write rate
Coalescer flushes every 16ms; on a session with 1 MB/sec output, that's ~62 inserts/sec into a single table with FK. With 200 sessions — 12k inserts/sec. SQLite handles this but only with WAL + appropriate `synchronous=NORMAL` (already set). No insert rate cap mentioned; daemon will OOM the WAL on burst. Pin a per-session backpressure (e.g., drop subscribers if backlog > N).

### S1-07-2. WAL checkpoint policy
`wal_autocheckpoint = 1000` (pages). On heavy delta write, WAL grows rapidly. No cap on WAL size before forced checkpoint. Pin or document expected WAL footprint.

### S1-07-3. `crash_log` retention pruner runs "at boot and every 6 hours"
Hardcoded 6-hour tick. Chapter 13 phase 7 mentions retention enforcer but no other cadence info. Pin in 09 / 07.

## Markdown hygiene
- §3 SQL block tagged `sql`. Good.
- §2 table OK.
- §6 "Restore: Settings → Restore stops sessions, swaps the file, reboots the daemon" — refers to a Settings UI flow that chapter 09 §5 does not list (chapter 09 §5 lists Backup but not Restore). Cross-chapter UI contract missing. P1.
