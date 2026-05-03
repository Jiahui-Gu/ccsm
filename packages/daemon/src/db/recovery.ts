// packages/daemon/src/db/recovery.ts
//
// Boot-time SQLite corrupt-DB recovery.
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//   ch07 §6 "Corrupt-DB recovery (FOREVER-STABLE)" — daemon boot ordering
//   for the integrity check (steps 1–4):
//
//     1. Open `state/ccsm.db` read-only via better-sqlite3 with
//        `busy_timeout = 5000`.
//     2. Run `PRAGMA integrity_check` (the FULL check — `quick_check` is
//        explicitly forbidden by spec; full costs O(seconds) on multi-MiB
//        DBs which is acceptable on the boot path).
//     3. Treat any result other than the single string `"ok"` as failure.
//     4. On failure, BEFORE opening any new DB:
//        a. Compute `corrupt_path = <db>.corrupt-<unix_ms>`.
//        b. Rename the DB and its `-wal` / `-shm` siblings to the corrupt
//           paths atomically (per-OS rename guarantees only — see notes).
//        c. Append a NDJSON line to `state/crash-raw.ndjson` BEFORE the
//           caller opens any new DB. The NDJSON file is the FOREVER-STABLE
//           crash sidecar (ch09 §1 capture-source `sqlite_corruption_recovered`).
//        d. fsync the NDJSON's parent directory so the append survives a
//           power loss before the next checkpoint.
//        e. Set the daemon's in-memory `recovery_modal_pending` flag — the
//           supervisor server reads it via the injected `RecoveryFlag`
//           interface and surfaces it on `/healthz`.
//
// SRP:
//   - This module is a *decider + sink*: it asks SQLite "are you ok?",
//     and on failure performs filesystem renames + a single NDJSON append.
//     It does NOT open a new DB, run migrations, or talk to the supervisor.
//     The caller (daemon entrypoint) owns those steps.
//   - The recovery flag is a tiny mutable struct (`RecoveryFlag`) the
//     entrypoint constructs and shares with the supervisor server. We do
//     NOT use a module-level singleton: that would couple this module to
//     the supervisor's lifetime and complicate testing.
//
// Layer 1 alternatives checked:
//   - SQLite `.recover` CLI: spec ch07 §6 explicitly rejects in-place
//     repair: "SQLite's `.recover` CLI is not bundled with `better-sqlite3`
//     and a v0.3 daemon does not embed a SQLite shell."
//   - VACUUM INTO: requires an openable DB; we are by construction in the
//     branch where the DB failed integrity_check, so VACUUM is unsafe.
//   - Custom data-salvage walker: explicitly out of scope per spec
//     ("optimizes for daemon-survives + user-told + original-preserved
//     over magic restoration").

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  renameSync,
} from 'node:fs';
import * as path from 'node:path';

import { loadNative } from '../native-loader.js';

// Sea binaries cannot embed `.node`; resolve the native addon through the
// shared loader (spec ch10 §2). Dev/test path is unchanged.
const Database = loadNative('better_sqlite3');

import { appendCrashRaw, type CrashRawEntry } from '../crash/raw-appender.js';

// ---------------------------------------------------------------------------
// RecoveryFlag — shared mutable struct between this module and the
// supervisor server.
// ---------------------------------------------------------------------------

/**
 * Diagnostic payload set when the daemon recovered from a corrupt DB.
 * Spec ch07 §6 step 4(e): the supervisor exposes this on `/healthz` as
 * `{ ..., "recovery_modal": { "pending": true, "ts_ms": <now>,
 *                              "corrupt_path": "..." } }`.
 *
 * `pending = false` means no recovery modal is needed (steady-state OR
 * the user has already POSTed `/ack-recovery`).
 */
export interface RecoveryModalState {
  /** True iff Electron should display the corruption-recovered modal. */
  pending: boolean;
  /** Wall-clock ms when the recovery happened (0 when `pending=false`). */
  ts_ms: number;
  /** Absolute path to the renamed corrupt DB ('' when `pending=false`). */
  corrupt_path: string;
}

/**
 * Mutable recovery flag passed by reference from the entrypoint to (a) the
 * recovery checker (which sets it on failure) and (b) the supervisor server
 * (which reads it for /healthz and clears it on /ack-recovery).
 *
 * Plain object with two methods — no event emitter, no observable. The
 * supervisor polls on each /healthz request, which is exactly what the
 * Electron client needs (it polls /healthz on attach per ch07 §6).
 */
export interface RecoveryFlag {
  /** Read the current modal state (returns a frozen snapshot). */
  read(): Readonly<RecoveryModalState>;
  /**
   * Mark recovery as having happened. Idempotent at the daemon-process
   * level — once set, stays set until `clear()` is called (typically by
   * `/ack-recovery`).
   */
  set(tsMs: number, corruptPath: string): void;
  /** Clear the flag (called by supervisor's `/ack-recovery` handler). */
  clear(): void;
}

/** Build a fresh RecoveryFlag in the cleared state. */
export function makeRecoveryFlag(): RecoveryFlag {
  let state: RecoveryModalState = { pending: false, ts_ms: 0, corrupt_path: '' };
  return {
    read() {
      // Freeze a snapshot so callers cannot mutate the internal state via
      // the returned reference. The supervisor's /healthz handler is a
      // sink — it reads + serialises, never writes.
      return Object.freeze({ ...state });
    },
    set(tsMs, corruptPath) {
      state = { pending: true, ts_ms: tsMs, corrupt_path: corruptPath };
    },
    clear() {
      state = { pending: false, ts_ms: 0, corrupt_path: '' };
    },
  };
}

// ---------------------------------------------------------------------------
// Public entry point.
// ---------------------------------------------------------------------------

export interface CheckAndRecoverOpts {
  /**
   * Absolute path to the SQLite DB file (typically `statePaths().db`).
   */
  readonly dbPath: string;
  /**
   * Absolute path to `state/crash-raw.ndjson` (typically
   * `statePaths().crashRaw`). Spec ch07 §6 step 4(c): the corruption event
   * is appended HERE, NOT to the new SQLite (which doesn't exist yet at
   * this point in boot).
   */
  readonly crashRawPath: string;
  /** RecoveryFlag the supervisor server consults on /healthz. */
  readonly flag: RecoveryFlag;
  /**
   * Wall-clock provider — defaults to `Date.now`. Tests inject a stub so
   * the rename suffix and the NDJSON ts_ms are deterministic.
   */
  readonly now?: () => number;
}

export interface CheckAndRecoverResult {
  /** True iff the integrity check passed (or the DB file did not exist). */
  readonly ok: boolean;
  /**
   * True iff a corruption was detected and the file was renamed. When
   * `recovered = true`, the caller MUST proceed to open a fresh DB and
   * (if the migration runner from #56 is available) re-run migrations.
   */
  readonly recovered: boolean;
  /** Path the corrupt DB was renamed to (empty when `recovered=false`). */
  readonly corruptPath: string;
  /**
   * Raw `PRAGMA integrity_check` output text (truncated to 64 KiB per
   * spec ch07 §6 step 4(c)). Empty string when `ok=true` or when the DB
   * file did not exist.
   */
  readonly integrityOutput: string;
}

/**
 * Run the spec ch07 §6 boot-time integrity check + (on failure) rename +
 * NDJSON append + flag set. Pure orchestration; the caller wires the
 * result into the lifecycle / migration runner / supervisor server.
 *
 * Behaviour matrix:
 *
 *   | DB file state              | Returns                                |
 *   |----------------------------|----------------------------------------|
 *   | absent (first boot)        | `{ok:true, recovered:false, ...}`      |
 *   | present, integrity_check OK| `{ok:true, recovered:false, ...}`      |
 *   | present, corrupt           | `{ok:false, recovered:true, ...}`,     |
 *   |                            | DB renamed, NDJSON appended, flag set  |
 *   | present, fully unreadable  | `{ok:false, recovered:true, ...}`,     |
 *   | (PRAGMA throws)            | DB renamed, NDJSON appended (status:   |
 *   |                            | 'unrecoverable' detail), flag set      |
 *
 * The function does NOT open the new DB or run migrations — the caller
 * (daemon entrypoint) does that AFTER this returns.
 */
export function checkAndRecover(opts: CheckAndRecoverOpts): CheckAndRecoverResult {
  const { dbPath, crashRawPath, flag } = opts;
  const now = opts.now ?? Date.now;

  // Spec step (no-op): if the DB file doesn't exist yet, this is the
  // first-ever boot. Skip the integrity check; the caller will create the
  // DB fresh. We do NOT touch the flag (it stays in its constructor
  // default state — `pending=false`).
  if (!existsSync(dbPath)) {
    return { ok: true, recovered: false, corruptPath: '', integrityOutput: '' };
  }

  // Spec step 1: open read-only, busy_timeout=5000. We do NOT use the
  // shared `openDatabase()` wrapper here — it applies the full BOOT_PRAGMA
  // suite (WAL mode etc.), which is wrong for the integrity check (we want
  // to read the file as-is, not switch its journal mode). The wrapper also
  // throws on PRAGMA failure, which would prevent us from running the
  // integrity check on a partially-corrupt file.
  let integrityOutput = '';
  let integrityFailed = false;
  let openThrew = false;

  try {
    const db = new Database(dbPath, { readonly: true });
    try {
      db.pragma('busy_timeout = 5000');
      // Spec step 2: PRAGMA integrity_check (FULL — never quick_check).
      // better-sqlite3 returns an array of `{ integrity_check: string }`
      // rows. The healthy case is exactly one row with value 'ok'.
      const rows = db.pragma('integrity_check') as ReadonlyArray<{
        integrity_check?: unknown;
      }>;
      const lines: string[] = [];
      for (const row of rows) {
        const v = row?.integrity_check;
        if (typeof v === 'string') lines.push(v);
        else lines.push(String(v));
      }
      // Spec step 3: any non-`"ok"` result (multi-row OR single-row with
      // non-'ok' text) is failure.
      if (lines.length === 1 && lines[0] === 'ok') {
        integrityFailed = false;
      } else {
        integrityFailed = true;
        integrityOutput = lines.join('\n');
      }
    } finally {
      try {
        db.close();
      } catch {
        // best-effort
      }
    }
  } catch (err) {
    // The PRAGMA itself threw — the file is so badly corrupt SQLite cannot
    // even open it. Treat as failure with a status sentinel in the NDJSON
    // detail (per task brief: "if PRAGMA integrity_check fails fully,
    // write {status: unrecoverable} and move on").
    openThrew = true;
    integrityFailed = true;
    integrityOutput = JSON.stringify({
      status: 'unrecoverable',
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (!integrityFailed) {
    return { ok: true, recovered: false, corruptPath: '', integrityOutput: '' };
  }

  // ---- Failure path: rename + NDJSON append + flag set --------------------

  const tsMs = now();
  const corruptPath = `${dbPath}.corrupt-${tsMs}`;

  // Spec step 4(b): rename the DB and its -wal / -shm siblings. We
  // best-effort rename the siblings — they may not exist (e.g. clean
  // shutdown leaves no -wal because of TRUNCATE; or an exotic corruption
  // wiped the sidecars). The DB file itself MUST rename or we cannot
  // proceed; that error propagates.
  renameSync(dbPath, corruptPath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${dbPath}${suffix}`;
    if (existsSync(sidecar)) {
      try {
        renameSync(sidecar, `${corruptPath}${suffix}`);
      } catch {
        // best-effort: a sidecar rename failure does not block recovery.
        // The corrupt DB is already renamed; the new boot creates fresh
        // sidecars next to a fresh DB. Stale -wal/-shm next to the OLD
        // path would be an issue, but we already renamed the parent.
      }
    }
  }

  // Spec step 4(c): append the NDJSON line. We use the shared
  // `appendCrashRaw` from #62's appender so the line shape matches every
  // other crash event. Source = 'sqlite_corruption_recovered' (locked by
  // ch09 §1).
  const detail = openThrew
    ? integrityOutput
    : truncate(integrityOutput, 64 * 1024);
  const entry: CrashRawEntry = {
    // Stable id derived from the corrupt path so a re-replay (file
    // truncate race per ch09 §6.2 case (e)) dedups correctly. We do NOT
    // import a ULID library — the path-based id is unique per recovery
    // event by construction.
    id: `corrupt-db-${tsMs}`,
    ts_ms: tsMs,
    source: 'sqlite_corruption_recovered',
    summary: `PRAGMA integrity_check returned non-ok; renamed db to ${corruptPath}`,
    detail,
    labels: { corrupt_path: corruptPath, db_path: dbPath },
    owner_id: 'daemon-self',
  };
  appendCrashRaw(crashRawPath, entry);

  // Spec step 4(d): fsync the NDJSON's parent directory so the metadata
  // (the new file size after append) is durable across power loss. POSIX
  // requires an explicit dir fsync after a file create / append for
  // strict durability; on win32 dir handles aren't fsync-able the same
  // way and `fsyncSync` on a directory fd is a no-op or EPERM. Best-effort
  // either way — the appender already fsync'd the file fd itself.
  try {
    const dir = path.dirname(crashRawPath);
    const dfd = openSync(dir, 'r');
    try {
      fsyncSync(dfd);
    } finally {
      closeSync(dfd);
    }
  } catch {
    // win32 / restricted fs — file fsync is the durability guarantee.
  }

  // Spec step 4(e): set the in-memory flag the supervisor reads.
  flag.set(tsMs, corruptPath);

  return {
    ok: false,
    recovered: true,
    corruptPath,
    integrityOutput,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxBytes: number): string {
  // UTF-8 byte-length truncation. Most integrity_check output is ASCII so
  // a code-unit slice is fine; for safety we re-encode and slice on bytes.
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  return buf.subarray(0, maxBytes).toString('utf8');
}
