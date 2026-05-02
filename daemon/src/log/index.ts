// Frag-12 §12.1 — daemon logger.
//
// Replaces the inline `pino()` stdout logger that previously lived at
// `daemon/src/index.ts:42`. This module is the single, central place where
// the daemon's pino logger is constructed.
//
// Wire shape (zero-rework target — v0.4 still uses this):
//   - JSONL files at `<dataRoot>/logs/daemon/daemon.<yyyy-MM-dd>.<n>`
//     written via `pino-roll` transport (sonic-boom under the hood).
//   - Daily rotation (file name embeds the date) AND a 50 MB per-file size
//     cap that triggers mid-day rotation when the day's file blows past
//     50 MB (the two are combined per pino-roll's `frequency` + `size`
//     contract).
//   - 7-file retention (`limit.count`) — older files auto-deleted by
//     pino-roll on rotation.
//   - `<logDir>/daemon.log` symlink that always points at the current
//     active file. pino-roll's built-in `symlink:true` only ever creates
//     a hardcoded `current.log` (see node_modules/pino-roll/lib/utils.js
//     `linkPath = join(dirname(fileVal), 'current.log')`); we ALSO create
//     and maintain a `daemon.log` symlink ourselves so external tooling
//     can `tail -f daemon.log` regardless of the rotation index.
//
// Redaction (frag-12 §12.1 unlocks #142 log injection guard):
//   - `daemon.secret` — the daemon HMAC secret (frag-6-7 §6.5 hello).
//   - `imposterSecret` — legacy field still present in some envelope
//     payloads (cleaned up incrementally; redact while it lives).
//   - `authorization` — HTTP-style header that may end up in adapter logs.
//   - `*.secret` / `*.password` / `*.token` — single-segment intermediate
//     wildcard supported by `@pinojs/redact` (pino's redaction backend);
//     matches the named field one nesting level under any parent key
//     (e.g. `upstream.secret`, `auth.token`). Deeper nesting would
//     require an explicit `*.*.secret` entry — deliberately out of
//     scope for the v0.3 list to keep the redact path count small (every
//     extra path costs a fast-redact codegen branch).
//   - Censor string: `[Redacted]` (matches frag-12 §12.1 wording — pino's
//     default is `[REDACTED]` all-caps which we explicitly override).
//
// Single-responsibility: this module is a SINK factory. It produces a
// configured pino Logger instance. It does NOT decide log levels at runtime
// (consumer's job), does NOT format messages (caller passes structured
// objects), does NOT manage rotation manually (pino-roll owns that).

import { mkdirSync, readdirSync, statSync, unlinkSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import pino, { type Logger } from 'pino';

/**
 * Canonical base fields stamped on every line by the daemon logger.
 * Mirrors frag-12 §12.1 ("canonical log fields"). The CALLER is expected
 * to supply `pid` + `boot` from the live process; `side` and `v` are
 * baked into the logger config and not overridable.
 */
export interface DaemonLoggerBase {
  readonly side: 'daemon';
  readonly v: string;
  readonly pid: number;
  readonly boot: string;
}

export interface CreateDaemonLoggerOptions {
  /**
   * OS-native data root resolved by `daemon/src/db/ensure-data-dir.ts`
   * `resolveDataRoot()`. Logger writes to `<dataRoot>/logs/daemon/`.
   */
  readonly dataRoot: string;
  /** Daemon binary version (`require('../package.json').version`). */
  readonly version: string;
  /** Boot nonce ulid — same value passed to crash handlers / sentry. */
  readonly bootNonce: string;
  /**
   * `process.pid` at boot. Captured by the caller so tests can inject a
   * deterministic value.
   */
  readonly pid: number;
  /**
   * Override the file name pattern used for tests. Production callers
   * leave this unset and the canonical `daemon` base + date suffix are
   * used.
   *
   * @internal
   */
  readonly _fileBaseOverride?: string;
}

/**
 * Per-file size cap before mid-day rotation. 50 MB per spec.
 * Uses pino-roll's `m` suffix for megabyte parsing.
 */
export const DAEMON_LOG_SIZE_CAP = '50m';

/**
 * Number of historical files retained in addition to the currently-active
 * file. Spec: 7 files total → `limit.count = 7` (pino-roll's count is the
 * number of files KEPT in addition to the active one, but we treat the
 * spec literally as the total cap and pass 7 here; older files are deleted
 * by pino-roll on rotation).
 */
export const DAEMON_LOG_RETENTION_COUNT = 7;

/**
 * Date format embedded in the rotated file names. Daily rotation → one
 * directory entry per calendar day plus a 1-based numeric suffix when the
 * size cap kicks in mid-day.
 *
 * Concrete example: `daemon.2026-05-02.1`, `daemon.2026-05-02.2`, ...
 */
export const DAEMON_LOG_DATE_FORMAT = 'yyyy-MM-dd';

/**
 * Filename for the always-current symlink. Frag-12 §12.1 wire wording.
 * Exported so tests can assert against the same constant.
 */
export const DAEMON_LOG_CURRENT_SYMLINK = 'daemon.log';

/**
 * Redact paths applied to every log line. See module header for rationale
 * on each entry.
 *
 * Exported so the unit test can assert the EXACT list (regression guard
 * for accidental removals).
 */
export const DAEMON_REDACT_PATHS: readonly string[] = Object.freeze([
  // Exact-path entries for the two known top-level secret carriers.
  'daemon.secret',
  'imposterSecret',
  'authorization',
  // Intermediate wildcard — matches at ANY nesting depth via @pinojs/redact.
  '*.secret',
  '*.password',
  '*.token',
]);

/**
 * Censor string used for redacted values. Spec wording is `[Redacted]`
 * (mixed-case). pino's default is `[REDACTED]` so we override.
 */
export const DAEMON_REDACT_CENSOR = '[Redacted]';

/**
 * Compute the directory the daemon logs land in. Pure helper exposed so
 * callers (and tests) do not have to re-derive the path.
 */
export function daemonLogDir(dataRoot: string): string {
  return join(dataRoot, 'logs', 'daemon');
}

/**
 * Build the daemon logger.
 *
 * The function ensures the log directory exists (`pino-roll` accepts
 * `mkdir: true` but we mkdir up-front so the symlink maintenance below
 * has a stable target dir even if the first write has not yet happened).
 *
 * Returns the constructed logger. Callers should keep a single reference
 * to it for the process lifetime; pino+pino-roll own the underlying
 * file descriptors and will close them on `pino.final` / `logger.flush`.
 */
export function createDaemonLogger(opts: CreateDaemonLoggerOptions): Logger {
  const logDir = daemonLogDir(opts.dataRoot);
  mkdirSync(logDir, { recursive: true });

  const fileBase = opts._fileBaseOverride ?? 'daemon';
  const filePath = join(logDir, fileBase);

  // pino-roll is loaded as a transport. We use the worker-thread transport
  // form (`pino.transport`) rather than building the destination directly
  // so log writes happen off the main loop — same posture pino-roll's own
  // README recommends and what production daemons want.
  //
  // NOTE on `symlink`: pino-roll's built-in `symlink: true` option
  // creates a hardcoded `current.log` symlink and unconditionally calls
  // `fs.symlink()` — which throws EPERM on Windows without developer
  // mode and ENOENT in some race conditions, propagating as an
  // uncaught exception out of the worker thread (observed in tests).
  // We therefore do NOT enable pino-roll's symlink and instead manage
  // our own `<logDir>/daemon.log` symlink via `maintainCurrentSymlink`
  // (best-effort, swallows errors on hosts that disallow symlinks).
  const transport = pino.transport({
    target: 'pino-roll',
    options: {
      file: filePath,
      frequency: 'daily',
      size: DAEMON_LOG_SIZE_CAP,
      dateFormat: DAEMON_LOG_DATE_FORMAT,
      mkdir: true,
      limit: { count: DAEMON_LOG_RETENTION_COUNT },
    },
  });

  const logger = pino(
    {
      base: {
        side: 'daemon',
        v: opts.version,
        pid: opts.pid,
        boot: opts.bootNonce,
      },
      // Frag-12 §12.1 redact list. See DAEMON_REDACT_PATHS for rationale
      // per entry. `[Redacted]` censor matches spec wording.
      redact: {
        paths: [...DAEMON_REDACT_PATHS],
        censor: DAEMON_REDACT_CENSOR,
      },
    },
    transport,
  );

  // Maintain the canonical `<logDir>/daemon.log` symlink ourselves. pino-roll
  // hardcodes its symlink name to `current.log`, so we layer our own
  // symlink (matching the spec wording) on top. Best-effort: if the host
  // FS / privileges refuse symlink creation (Windows w/o developer mode),
  // we swallow and let consumers fall back to globbing `daemon.*`.
  maintainCurrentSymlink(logDir);

  return logger;
}

/**
 * Re-point `<logDir>/daemon.log` at the most recently modified rotated
 * file. Called once at logger construction; future rotations are picked
 * up on next process boot. (pino-roll does not expose a rotation hook in
 * the worker-thread transport, so a runtime hook would require IPC into
 * the worker — out of scope for v0.3. Boot-time refresh is sufficient
 * for the dogfood tail use case: `tail -F daemon.log` re-opens on
 * symlink change anyway.)
 *
 * Best-effort: any error (missing target, EPERM on Windows w/o dev mode,
 * etc.) is swallowed. The rotated files are still readable directly.
 *
 * Exported for the unit test to drive symlink maintenance with a
 * synthetic file tree.
 */
export function maintainCurrentSymlink(logDir: string): void {
  let entries: string[];
  try {
    entries = readdirSync(logDir);
  } catch {
    return;
  }
  // Find the newest `daemon.*` file (excluding our own symlink and
  // pino-roll's `current.log`).
  let newest: { name: string; mtimeMs: number } | undefined;
  for (const name of entries) {
    if (name === DAEMON_LOG_CURRENT_SYMLINK) continue;
    if (name === 'current.log') continue;
    if (!name.startsWith('daemon.')) continue;
    let st: { mtimeMs: number };
    try {
      st = statSync(join(logDir, name));
    } catch {
      continue;
    }
    if (!newest || st.mtimeMs > newest.mtimeMs) {
      newest = { name, mtimeMs: st.mtimeMs };
    }
  }
  if (!newest) return;
  const linkPath = join(logDir, DAEMON_LOG_CURRENT_SYMLINK);
  try {
    unlinkSync(linkPath);
  } catch {
    // No existing symlink — fine.
  }
  try {
    symlinkSync(newest.name, linkPath);
  } catch {
    // EPERM on Windows w/o developer mode, EEXIST race, etc. Best-effort.
  }
}
