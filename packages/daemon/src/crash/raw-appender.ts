// packages/daemon/src/crash/raw-appender.ts
//
// Crash-raw NDJSON appender + boot-replay.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch07 §2 (state directory layout — `crash-raw.ndjson` location, frozen
//     per OS) and ch09 §2 (storage schema — locked NDJSON line shape with
//     `owner_id` required; boot-replay → dedup by id → import into
//     `crash_log` → truncate file).
//   - ch09 §1 owner_id attribution: `'daemon-self'` sentinel for daemon-side
//     crashes; principalKey for session-attributable crashes.
//   - ch09 §6.2 silent-loss safety modes covered by
//     `test/crash/crash-raw-recovery.spec.ts`:
//       (a) partial line at EOF, (b) file missing, (c) file present but
//       empty, (d) malformed entries, (e) truncation race.
//
// SRP / API surface (deliberately minimal — Layer 1 foundation for #62
// capture handlers and #64 retention pruner):
//
//   * `appendCrashRaw(path, entry)` — sink. Append one NDJSON line + fsync.
//     Open-flush-close per call. Designed for the FATAL path where the
//     daemon may exit microseconds later — every byte must hit the disk.
//   * `replayCrashRawOnBoot({ path, db })` — boot orchestrator: read all
//     parseable lines, INSERT-OR-IGNORE into `crash_log` (dedup by id),
//     fsync the DB page cache, THEN truncate the file. Order matters:
//     truncate AFTER successful import so a crash mid-replay loses nothing.
//
// Out of scope (owned by other tasks — DO NOT touch from here):
//   - Capture handlers (uncaughtException, sqlite_op, claude_exit, ...)  → T5.11 / Task #62
//   - Retention pruner (10000 rows / 90 days)                             → T5.12 / Task #64
//   - Coalescer / write batching                                          → T5.6 / Task #58
//   - Schema (`crash_log` columns)                                        → frozen by #876
//   - State path constants (`crashRaw`)                                   → owned by state-dir/paths.ts (T5.3)

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  truncateSync,
  writeSync,
} from 'node:fs';

import type { SqliteDatabase } from '../db/sqlite.js';

// ---------------------------------------------------------------------------
// Line shape — locked by spec ch09 §2. Adding fields is forbidden in v0.3
// (forever-stable per the §7 v0.4 delta: "Unchanged: ... NDJSON line shape").
// ---------------------------------------------------------------------------

/**
 * One crash event as it appears (a) on the NDJSON wire format and (b) as a
 * row in the `crash_log` table. Field order in the spec example:
 *
 *   {"id":"01H...","ts_ms":...,"source":"sqlite_open","summary":"...",
 *    "detail":"...","labels":{...},"owner_id":"daemon-self"}
 *
 * `owner_id` is REQUIRED (not optional) — `'daemon-self'` for daemon-side
 * crashes, principalKey (e.g. `'unix-user:1000'`) for session-attributable
 * ones. The sentinel is NOT a valid principalKey (no colon) — see ch09 §1.
 */
export interface CrashRawEntry {
  /** ULID, lexicographically time-ordered. PRIMARY KEY in `crash_log`. */
  readonly id: string;
  /** Event time in unix ms. */
  readonly ts_ms: number;
  /** Open string set per ch09 §1 — `sqlite_open`, `claude_exit`, ... */
  readonly source: string;
  /** Short human description; goes into `crash_log.summary`. */
  readonly summary: string;
  /** Long detail (stack trace, last stderr bytes, ...); `crash_log.detail`. */
  readonly detail: string;
  /** Free-form key/value labels; serialised into `crash_log.labels_json`. */
  readonly labels: Readonly<Record<string, string>>;
  /** principalKey or `'daemon-self'` sentinel. NOT NULL in `crash_log`. */
  readonly owner_id: string;
}

// ---------------------------------------------------------------------------
// Appender — synchronous, open-flush-close per call. Used by the FATAL path
// where the daemon may exit immediately after.
// ---------------------------------------------------------------------------

/**
 * Append one NDJSON entry to `path` and fsync. Synchronous on purpose:
 *
 *   - The append is invoked from `process.on('uncaughtException', ...)` and
 *     similar fatal hooks (T5.11) where Node's event loop may already be
 *     in tear-down. Async APIs that defer to the next tick can lose data.
 *   - `O_APPEND` (`'a'` mode) gives atomic append on POSIX for writes
 *     ≤ PIPE_BUF (4 KiB). Our serialised line + `\n` is well under that
 *     for every realistic crash payload (we don't bound it here, but if a
 *     line ever exceeds it the filesystem still serialises by design).
 *   - On Windows, the runtime's `'a'` flag maps to `FILE_APPEND_DATA`
 *     access right; the OS serialises appends.
 *
 * The function `fsyncSync` after the write so the entry survives a power
 * loss / hard kill that follows the appender call. Fsync errors are
 * propagated — the FATAL caller will then write a structured-log line and
 * exit; better to surface "we tried and failed" than silently lose the
 * event.
 *
 * Concurrent append safety: callers running in different threads / workers
 * must each call `appendCrashRaw` themselves. The kernel's `O_APPEND`
 * semantics keep individual line-writes intact; we never read-modify-write.
 */
export function appendCrashRaw(path: string, entry: CrashRawEntry): void {
  const line = `${serialiseEntry(entry)}\n`;
  // 0o600: file is created on first append; matches the state-dir 0o700 dir
  // mode (only the daemon's service account reads it). No-op on win32 (the
  // installer manages DACLs per ch10 §5).
  const fd = openSync(path, 'a', 0o600);
  try {
    writeSync(fd, line);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Serialise an entry to a single JSON object string with no embedded
 * newlines. We do NOT pretty-print and we do NOT allow `entry.labels` to be
 * `undefined` (the schema requires `labels_json NOT NULL DEFAULT '{}'` —
 * the wire shape mirrors that with `{}`).
 *
 * `JSON.stringify` already escapes embedded newlines inside string values,
 * so the resulting line is guaranteed not to contain `\n` except the one
 * we append in `appendCrashRaw`. This is what makes the file recoverable
 * line-by-line on boot.
 */
function serialiseEntry(entry: CrashRawEntry): string {
  // Object literal order matches the spec example for human readability;
  // JSON readers don't care about field order, but a future grep / `jq`
  // session by an operator does.
  return JSON.stringify({
    id: entry.id,
    ts_ms: entry.ts_ms,
    source: entry.source,
    summary: entry.summary,
    detail: entry.detail,
    labels: entry.labels,
    owner_id: entry.owner_id,
  });
}

// ---------------------------------------------------------------------------
// Boot-replay — silent-loss safe.
// ---------------------------------------------------------------------------

export interface ReplayResult {
  /** How many parseable lines we read from the file. */
  readonly linesRead: number;
  /** How many were inserted (i.e. not already present in `crash_log`). */
  readonly inserted: number;
  /** How many were dropped because they failed JSON / shape validation. */
  readonly malformed: number;
  /** True when the file was missing (boot before any fatal append). */
  readonly fileMissing: boolean;
}

export interface ReplayOpts {
  /** Path to `state/crash-raw.ndjson` — typically `statePaths().crashRaw`. */
  readonly path: string;
  /** Open `crash_log` SQLite handle (PRAGMAs already applied). */
  readonly db: SqliteDatabase;
}

/**
 * Replay the NDJSON file into `crash_log`, then truncate the file.
 *
 * Order is load-bearing for silent-loss safety (ch09 §6.2 case (e) —
 * "truncation race"):
 *
 *   1. Read the whole file into memory (it's bounded by daemon-fatal
 *      events between two boots — typically empty or a handful of lines;
 *      a pathological loop is bounded by retention §3, separate task #64).
 *   2. Skip the trailing partial line if any (no `\n` terminator) — case
 *      (a). Such a line is by definition mid-write at the previous fatal;
 *      we cannot trust it. The spec's "fsync where appropriate" guidance
 *      means complete lines are durable; partial lines are the cost of
 *      ungraceful exit, accepted.
 *   3. Parse each remaining line. Malformed lines (case (d)) are counted
 *      and skipped — never throw mid-replay; one corrupt line must not
 *      block the dozen good ones behind it.
 *   4. INSERT OR IGNORE within a single IMMEDIATE transaction. The unique
 *      `id` PRIMARY KEY gives us O(1) dedup against rows already imported
 *      by a previous incomplete replay (case (e) — daemon killed between
 *      INSERT and TRUNCATE).
 *   5. fsync the DB checkpoint via `pragma('wal_checkpoint(FULL)')` BEFORE
 *      truncating. Otherwise the import could live in WAL only and a
 *      power loss after truncate but before next checkpoint would lose
 *      every imported row.
 *   6. Truncate the file to 0 bytes. We do NOT delete it — keeping the
 *      inode stable means open file handles in the appender (if any
 *      racy pre-existing fd exists from another process) keep working,
 *      and avoids a TOCTOU window between unlink and recreate. Truncate
 *      is one syscall.
 *
 * Cases (b) "file missing" and (c) "empty file" both return early with
 * `inserted=0, malformed=0`.
 */
export function replayCrashRawOnBoot(opts: ReplayOpts): ReplayResult {
  const { path, db } = opts;

  let raw: Buffer;
  try {
    raw = readFileSync(path);
  } catch (err) {
    if (isENOENT(err)) {
      // Case (b): file missing. First-ever boot, or a previous boot replay
      // ran on a system where the truncate raced with an unlink (we don't
      // unlink, but a future op might).
      return { linesRead: 0, inserted: 0, malformed: 0, fileMissing: true };
    }
    throw err;
  }

  if (raw.length === 0) {
    // Case (c): file present but empty. Steady-state between fatals.
    return { linesRead: 0, inserted: 0, malformed: 0, fileMissing: false };
  }

  // Case (a): drop trailing partial line if no terminator. We split on
  // '\n' and discard the last segment ONLY if the file does not end with
  // '\n'. A clean-exit producer always writes the trailing '\n'.
  const text = raw.toString('utf8');
  const segments = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  // After split, a trailing '\n' produces a final '' segment we always
  // discard. A missing trailing '\n' produces a final partial we also
  // discard. Either way we drop the last segment when it would be a
  // partial — pop the empty AND pop the partial.
  if (endsWithNewline) {
    segments.pop(); // drop the '' produced by trailing '\n'
  } else {
    segments.pop(); // drop the partial line
  }

  const entries: CrashRawEntry[] = [];
  let malformed = 0;
  for (const seg of segments) {
    if (seg.length === 0) {
      // Blank line (e.g. two consecutive '\n'). Not malformed per se but
      // not an entry either — skip silently.
      continue;
    }
    const parsed = tryParseEntry(seg);
    if (parsed === null) {
      malformed++;
      continue;
    }
    entries.push(parsed);
  }

  // Step 4: INSERT OR IGNORE inside one IMMEDIATE transaction. We skip the
  // INSERT pass entirely when there are no entries — saves a transaction
  // round-trip on the steady-state "file present but empty" path that
  // already early-returned above; also saves it when every line was
  // malformed.
  let inserted = 0;
  if (entries.length > 0) {
    const insertStmt = db.prepare(
      // labels_json maps from CrashRawEntry.labels via JSON.stringify.
      // INSERT OR IGNORE => dedup on PRIMARY KEY (id).
      `INSERT OR IGNORE INTO crash_log
         (id, ts_ms, source, summary, detail, labels_json, owner_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const txn = db.transaction((rows: readonly CrashRawEntry[]) => {
      let count = 0;
      for (const e of rows) {
        const info = insertStmt.run(
          e.id,
          e.ts_ms,
          e.source,
          e.summary,
          e.detail,
          JSON.stringify(e.labels),
          e.owner_id,
        );
        if (info.changes === 1) count++;
      }
      return count;
    });
    // BEGIN IMMEDIATE so a concurrent reader (none expected at boot, but
    // be defensive) can't sneak between our SELECT-implicit dedup check
    // and the INSERT.
    inserted = (txn as unknown as (rows: readonly CrashRawEntry[]) => number)(entries);
  }

  // Step 5: force durability of the inserts to the main DB file BEFORE we
  // truncate the NDJSON. WAL checkpoint(FULL) blocks until the WAL frames
  // are merged into the main file and the main file is fsynced (with
  // synchronous=NORMAL — see db/sqlite.ts BOOT_PRAGMAS). Without this, a
  // crash between truncate and the next implicit checkpoint loses rows.
  db.pragma('wal_checkpoint(FULL)');

  // Step 6: truncate to 0 bytes. Synchronous; we want the metadata flush
  // before returning. Errors propagate — caller logs via the supervisor
  // structured-log path.
  truncateSync(path, 0);

  return {
    linesRead: entries.length + malformed,
    inserted,
    malformed,
    fileMissing: false,
  };
}

/**
 * Parse + minimally validate one NDJSON line. Returns `null` (NOT throws)
 * for any failure — the replay loop counts and skips. Validation is shape
 * only: required fields present and of correct primitive type. We do NOT
 * validate `id` is a ULID, `ts_ms` is plausible, or `source` is in the
 * §1 known set — all three are open by spec (ULID is a hint, source is an
 * open string set, ts_ms can legally be 0 in tests). The DB schema's
 * `NOT NULL` constraints catch anything truly broken at insert time.
 */
function tryParseEntry(line: string): CrashRawEntry | null {
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const o = obj as Record<string, unknown>;
  if (typeof o.id !== 'string' || o.id.length === 0) return null;
  if (typeof o.ts_ms !== 'number' || !Number.isFinite(o.ts_ms)) return null;
  if (typeof o.source !== 'string' || o.source.length === 0) return null;
  if (typeof o.summary !== 'string') return null;
  if (typeof o.detail !== 'string') return null;
  if (typeof o.owner_id !== 'string' || o.owner_id.length === 0) return null;
  // labels: object of string→string. Missing → coerce to {} (file
  // generated by an older daemon should still replay; v0.3 is the
  // baseline, but be defensive).
  let labels: Record<string, string> = {};
  if (o.labels !== undefined) {
    if (typeof o.labels !== 'object' || o.labels === null) return null;
    const lo = o.labels as Record<string, unknown>;
    for (const k of Object.keys(lo)) {
      const v = lo[k];
      if (typeof v !== 'string') return null;
      labels[k] = v;
    }
  }
  return {
    id: o.id,
    ts_ms: o.ts_ms,
    source: o.source,
    summary: o.summary,
    detail: o.detail,
    labels,
    owner_id: o.owner_id,
  };
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'ENOENT'
  );
}
