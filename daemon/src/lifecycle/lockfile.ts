// Task #123 — daemon single-instance lockfile (`<dataRoot>/daemon.lock`).
//
// Spec refs:
//   - frag-6-7 §6.4 "Single-instance + last-known-good rollback":
//       * Lockfile path = `<dataRoot>/daemon.lock`, acquired via
//         `proper-lockfile` with `O_EXCL` create + PID write.
//       * Lockfile MUST be acquired BEFORE `ensureDataDir()` / migration
//         (round-3 reliability P0-R4 ordering — frag-8 §8.3 step 1
//         depends on this; the orphan-tmp unlink in §8.3 step 1a is only
//         safe when single-daemon is enforced).
//       * Stale-PID recovery: Win uses `OpenProcess`-equivalent probe,
//         POSIX uses `kill(pid, 0)` ESRCH. If the holder PID is dead,
//         steal the lock with one warn line.
//       * Create-fail policy: any non-EEXIST error (EROFS, ENOSPC,
//         noexec) → daemon refuses to boot; no silent fall-back.
//   - frag-6-7 §6.4 step 4 (swap-lock): the `daemon.shutdownForUpgrade`
//     handler releases the SAME lock as part of its drain so the
//     supervisor's swap window cannot race a fresh-daemon-boot for the
//     bin/ directory.
//
// Single Responsibility (per repo memory `feedback_single_responsibility.md`):
//   - PRODUCER: `<dataRoot>` path (caller-supplied — same resolver
//     `resolveDataRoot()` from `daemon/src/db/ensure-data-dir.ts`).
//   - DECIDER: `probeHolderProcess(pid)` returns
//     `'alive' | 'gone' | 'unknown'` from a kill(0) / OpenProcess probe.
//     Pure (no I/O beyond the syscall itself). Mirrors the
//     `dev-parent-watchdog`'s `checkParent` shape so future consolidation
//     stays cheap.
//   - SINK: `acquireDaemonLock({ dataRoot, ... })` performs the
//     mkdir + atomic-acquire + PID-write + stale-recovery + log emit
//     dance. Returns a `LockHandle` with `release()`. Idempotent
//     release.
//
// What this module does NOT do:
//   - Does NOT decide WHEN to acquire — the daemon entry (`index.ts`)
//     calls it FIRST in the boot sequence, before `ensureDataDir`.
//   - Does NOT call `process.exit` directly. EROFS / IO-fatal cases
//     log + throw a typed error; the entry process maps to exit 78.
//     This keeps the module testable (tests catch the throw, no
//     real exit).
//   - Does NOT touch the §6.4 binary swap path — the upgrade handler
//     receives the `LockHandle.release` thunk and invokes it as part
//     of its own drain.
//
// Forward-compat (v0.4):
//   - The lockfile lives under `<dataRoot>` which is stable across
//     v0.3/v0.4 (frag-11 §11.6 path table is locked). The module
//     surface (acquire / release / probe) is the final shape — no
//     "v0.4 will replace this" placeholders.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// proper-lockfile has no `@types/` package and ships pure CJS. Declare
// the minimal surface we use locally so the rest of the file stays
// strictly typed. The full surface is documented in the package README.
interface ProperLockfile {
  lock: (
    file: string,
    options: {
      readonly realpath?: boolean;
      readonly stale?: number;
      readonly retries?: number;
      readonly lockfilePath?: string;
    },
  ) => Promise<() => Promise<void>>;
  unlock: (
    file: string,
    options: { readonly realpath?: boolean; readonly lockfilePath?: string },
  ) => Promise<void>;
  check: (
    file: string,
    options: { readonly realpath?: boolean; readonly lockfilePath?: string },
  ) => Promise<boolean>;
}

// Lazy-required so tests can stub via the deps seam below without
// triggering the real CJS load when only the pure decider is exercised.
function defaultProperLockfile(): ProperLockfile {
  return require('proper-lockfile') as ProperLockfile;
}

/** Filename under `<dataRoot>`. Exported so tests + the upgrade handler
 *  can derive the same path without re-stating the literal. */
export const DAEMON_LOCK_FILENAME = 'daemon.lock' as const;

/** Recommended exit code on EROFS-class fatal (sysexits.h: EX_CONFIG = 78,
 *  "configuration error"). Exported so the daemon entry can map without
 *  re-stating the literal. */
export const LOCKFILE_FATAL_EXIT_CODE = 78 as const;

/** Outcome of probing the holder process. Mirrors `dev-parent-watchdog`'s
 *  `ParentProbeOutcome` shape for future consolidation. */
export type HolderProbeOutcome = 'alive' | 'gone' | 'unknown';

export interface ProbeHolderOptions {
  /** Override `process.kill` for tests. POSIX path. */
  readonly kill?: (pid: number, signal: 0) => void;
  /** Test seam — overrides `process.platform`. */
  readonly platform?: NodeJS.Platform;
  /**
   * Windows-side probe seam. Returns:
   *   - `'alive'` when `OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,
   *     false, pid)` returns a non-NULL handle.
   *   - `'gone'` when GetLastError = ERROR_INVALID_PARAMETER (pid does
   *     not exist) or ERROR_ACCESS_DENIED with no handle.
   *   - `'unknown'` when the helper cannot be loaded or returns an
   *     unexpected error.
   *
   * Production default uses `process.kill(pid, 0)` on Windows too —
   * Node maps it through `OpenProcess(PROCESS_TERMINATE)` internally
   * which is sufficient for an existence check. The seam exists so a
   * future N-API helper (when the §7.M1 ACL helper lands) can swap in
   * `PROCESS_QUERY_LIMITED_INFORMATION` for a less-privileged check.
   */
  readonly probeWindows?: (pid: number) => HolderProbeOutcome;
}

/**
 * Pure decider: is the holder PID still alive?
 *
 * - POSIX: `process.kill(pid, 0)` — signal 0 is the documented existence
 *   check. ESRCH = process gone, EPERM = process exists but we cannot
 *   signal it (still alive, conservative posture: do NOT steal).
 * - Windows: `process.kill(pid, 0)` maps through `OpenProcess`. If the
 *   PID is gone the call throws ESRCH; if it exists but belongs to
 *   another user/session, it throws EPERM. Same conservative branch as
 *   POSIX — only ESRCH counts as "gone" / steal-eligible.
 *
 * Never throws.
 */
export function probeHolderProcess(
  pid: number,
  opts: ProbeHolderOptions = {},
): HolderProbeOutcome {
  const platform = opts.platform ?? process.platform;
  if (platform === 'win32' && opts.probeWindows) {
    return opts.probeWindows(pid);
  }
  const kill =
    opts.kill ??
    ((p: number, signal: 0): void => {
      process.kill(p, signal);
    });
  try {
    kill(pid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    // EPERM (POSIX) or any other code → treat as alive. Conservative:
    // never steal a lock from a process we merely cannot signal — that
    // would corrupt state if the holder is still actively writing.
    return 'unknown';
  }
}

/** Structured-log sink used by the acquire path. Matches pino's
 *  `(obj, msg)` signature so the entry process can pass `logger.info` /
 *  `logger.warn` / `logger.error` directly. */
export interface LockLogger {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
  error: (obj: Record<string, unknown>, msg: string) => void;
}

/** Test seam for swapping the proper-lockfile surface and the clock. */
export interface LockDeps {
  readonly properLockfile?: ProperLockfile;
  /** Override `Date.now()` so the `datarootMs` log field is deterministic. */
  readonly now?: () => number;
  /** Override `process.pid` so tests can simulate alternative holder PIDs. */
  readonly pid?: number;
  /** Override probe behaviour (forwarded to `probeHolderProcess`). */
  readonly probeOptions?: ProbeHolderOptions;
}

export interface AcquireDaemonLockOptions {
  /** OS-native data root (output of `resolveDataRoot()` from
   *  `daemon/src/db/ensure-data-dir.ts`). Lockfile is created at
   *  `<dataRoot>/daemon.lock`. */
  readonly dataRoot: string;
  readonly logger: LockLogger;
  readonly deps?: LockDeps;
}

/** Returned by `acquireDaemonLock`. `release()` is idempotent: a second
 *  call resolves immediately without touching the fs, so the upgrade
 *  handler + the `index.ts` shutdown path can both wire it without
 *  coordinating. */
export interface LockHandle {
  /** Absolute path to the lockfile (`<dataRoot>/daemon.lock`). */
  readonly path: string;
  /** PID written to the lockfile (== `process.pid` in production). */
  readonly pid: number;
  release: () => Promise<void>;
}

/** Typed error class used for the EROFS-class fatal branch. The daemon
 *  entry catches this and maps to `process.exit(LOCKFILE_FATAL_EXIT_CODE)`
 *  after a final stderr line — keeps the module pure (no exit calls). */
export class LockfileFatalError extends Error {
  public readonly code: string;
  public readonly path: string;
  public override readonly cause: unknown;
  constructor(message: string, params: { code: string; path: string; cause: unknown }) {
    super(message);
    this.name = 'LockfileFatalError';
    this.code = params.code;
    this.path = params.path;
    this.cause = params.cause;
  }
}

/** Typed error class for "lock is held by a live PID" — the second
 *  daemon's expected exit reason. Caller maps to a non-zero exit. */
export class LockfileBusyError extends Error {
  public readonly path: string;
  public readonly holderPid: number;
  constructor(path: string, holderPid: number) {
    super(`daemon.lock held by live PID ${holderPid} at ${path}`);
    this.name = 'LockfileBusyError';
    this.path = path;
    this.holderPid = holderPid;
  }
}

/**
 * Acquire `<dataRoot>/daemon.lock`. Performs (in order):
 *
 *   1. `mkdirSync(dataRoot, { recursive: true, mode: 0o700 })` — the
 *      data root MUST exist before proper-lockfile can mkdir its
 *      `.lock` sibling. The `data/` subdir is NOT created here; that's
 *      `ensureDataDir()`'s job (which runs AFTER lock acquire per
 *      r3-rel P0-R4 ordering).
 *   2. Touch `daemon.lock` (writeFile-empty if absent) so
 *      proper-lockfile's `realpath: true` default doesn't ENOENT.
 *      We pass `realpath: false` anyway — both are belt-and-suspenders.
 *   3. `properLockfile.lock(daemon.lock, { realpath: false, retries: 0 })`.
 *      The mkdir of `daemon.lock.lock` is the atomic gate (POSIX +
 *      Windows both make `mkdir` atomic w.r.t. existence checks).
 *   4. On success: write `${pid}\n` to `daemon.lock` (the file content
 *      is the steal-recovery payload), emit `lockfile_acquired`, return
 *      the handle.
 *   5. On `ELOCKED`: read PID from `daemon.lock`, `probeHolderProcess`.
 *      If `'gone'`: emit `lockfile_steal`, force-unlock via
 *      `properLockfile.unlock(...)`, retry ONCE. Cap at one retry to
 *      avoid an infinite steal loop if two dead-holder racers keep
 *      re-creating the file.
 *      If `'alive'` or `'unknown'`: throw `LockfileBusyError`.
 *   6. On `EROFS` / `EACCES` / `ENOSPC` / `EPERM` (read-only mount,
 *      permission denied, disk full): emit `lockfile_erofs_fatal`,
 *      throw `LockfileFatalError`.
 */
export async function acquireDaemonLock(
  options: AcquireDaemonLockOptions,
): Promise<LockHandle> {
  const { dataRoot, logger } = options;
  const properLockfile = options.deps?.properLockfile ?? defaultProperLockfile();
  const now = options.deps?.now ?? Date.now;
  const pid = options.deps?.pid ?? process.pid;
  const probeOptions = options.deps?.probeOptions ?? {};

  const lockPath = join(dataRoot, DAEMON_LOCK_FILENAME);
  const startedAt = now();

  // Step 1: ensure dataRoot exists. Mode 0o700 only applies to NEWLY
  // created directories on POSIX; pre-existing dirs keep their mode.
  // EROFS surfaces here first on a read-only mount.
  try {
    mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  } catch (err) {
    return raiseFatalIfReadOnly(err, lockPath, logger, startedAt, now);
  }

  // Step 2: touch the lock target file. proper-lockfile needs it to
  // exist so its `mkdir(file + '.lock')` has a sibling to anchor.
  // We tolerate a pre-existing file (idempotent) since the previous
  // boot's PID payload may still be sitting there — the stale-recovery
  // path will overwrite it after acquire.
  try {
    if (!existsSync(lockPath)) {
      writeFileSync(lockPath, '', { mode: 0o600 });
    }
  } catch (err) {
    return raiseFatalIfReadOnly(err, lockPath, logger, startedAt, now);
  }

  // Step 3 + 5: try acquire, on ELOCKED branch into stale-PID recovery.
  let stealAttempted = false;
  while (true) {
    let release: () => Promise<void>;
    try {
      release = await properLockfile.lock(lockPath, {
        realpath: false,
        retries: 0,
      });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ELOCKED') {
        if (stealAttempted) {
          // Already stole once; the new holder won the race fair and
          // square. Surface as busy to the caller.
          const holderPid = readHolderPidSafe(lockPath) ?? 0;
          throw new LockfileBusyError(lockPath, holderPid);
        }
        const holderPidOrNull = readHolderPidSafe(lockPath);
        // Unparseable / empty PID payload = the holder crashed mid-write
        // before stamping its PID. Treat as gone (steal-eligible) without
        // attempting the syscall probe — calling `process.kill` with a
        // bogus value (negative / 0) has dangerous semantics on POSIX
        // (broadcasts to process group).
        const outcome: HolderProbeOutcome =
          holderPidOrNull === null
            ? 'gone'
            : probeHolderProcess(holderPidOrNull, probeOptions);
        const holderPid = holderPidOrNull ?? 0;
        if (outcome === 'gone') {
          // Stale lock: steal it. Log first so a forensic timeline
          // exists even if the unlock or retry below throws.
          logger.warn(
            {
              event: 'lockfile_steal',
              stale_pid: holderPid,
              datarootMs: now() - startedAt,
              path: lockPath,
            },
            'stealing stale daemon lock',
          );
          // Best-effort steal: directly rmdir the `.lock` sibling dir.
          // We cannot call `properLockfile.unlock` here because it
          // refuses with ENOTACQUIRED unless we registered the lock in
          // its in-memory map (which only happens on a successful
          // `lock()`). Direct rmdir matches what proper-lockfile itself
          // does internally during its own stale-recovery branch.
          const staleLockDir = `${lockPath}.lock`;
          try {
            rmSync(staleLockDir, { recursive: true, force: true });
          } catch {
            // Swallow — the retry will resurface any real failure as
            // a fresh ELOCKED that the `stealAttempted` guard handles.
          }
          stealAttempted = true;
          continue;
        }
        // 'alive' or 'unknown' → second daemon must back off. The
        // supervisor's spawn-or-attach (§6.1) treats this exit code as
        // "attach to existing".
        throw new LockfileBusyError(lockPath, holderPid);
      }
      // Non-ELOCKED: EROFS / ENOSPC / EACCES / EPERM all hit here.
      return raiseFatalIfReadOnly(err, lockPath, logger, startedAt, now);
    }

    // Step 4: write PID payload. Crash here = stale lock with empty
    // payload; the next boot's stale-recovery path treats unparseable
    // PID as `'gone'` (see `readHolderPidSafe`) and steals.
    try {
      writeFileSync(lockPath, `${pid}\n`, { mode: 0o600 });
    } catch (err) {
      // PID write failed (extremely rare — we already created the file
      // above). Release the lock dir so the next boot can retry, then
      // route through the EROFS-fatal path so the supervisor surfaces
      // a clear error rather than silently holding a stale-payload lock.
      try {
        await release();
      } catch {
        // best-effort
      }
      return raiseFatalIfReadOnly(err, lockPath, logger, startedAt, now);
    }

    logger.info(
      {
        event: 'lockfile_acquired',
        pid,
        path: lockPath,
        datarootMs: now() - startedAt,
      },
      'daemon lockfile acquired',
    );

    let released = false;
    return {
      path: lockPath,
      pid,
      release: async (): Promise<void> => {
        if (released) return;
        released = true;
        await release();
      },
    };
  }
}

/** Best-effort read of the PID payload from `daemon.lock`. Returns `null`
 *  when the file is unreadable / empty / corrupt — the caller's
 *  stale-recovery path treats `null` as steal-eligible (the file payload
 *  is written non-atomically with the lock acquire so a partial-write
 *  here means the holder crashed mid-write). Returning `null` instead
 *  of a sentinel PID prevents accidentally calling `process.kill(0, 0)`
 *  (POSIX: broadcasts to the entire process group) or
 *  `process.kill(-1, 0)` (POSIX: signals every process the caller can
 *  reach). */
function readHolderPidSafe(lockPath: string): number | null {
  try {
    const raw = readFileSync(lockPath, 'utf8').trim();
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  } catch {
    // ENOENT / EACCES — fall through.
  }
  return null;
}

/** Map filesystem errors that indicate a non-recoverable lockfile site
 *  (read-only mount, permission denied, disk full) into a typed fatal
 *  + structured log line. Other error codes re-throw as-is so the
 *  caller's stack trace is preserved for debugging. */
function raiseFatalIfReadOnly(
  err: unknown,
  lockPath: string,
  logger: LockLogger,
  startedAt: number,
  now: () => number,
): never {
  const code = (err as NodeJS.ErrnoException).code ?? 'UNKNOWN';
  if (code === 'EROFS' || code === 'EACCES' || code === 'EPERM' || code === 'ENOSPC') {
    logger.error(
      {
        event: 'lockfile_erofs_fatal',
        code,
        path: lockPath,
        datarootMs: now() - startedAt,
        err: String(err),
      },
      'daemon lockfile site is unwritable; refusing to boot',
    );
    throw new LockfileFatalError(
      `daemon lockfile site unwritable (${code}) at ${lockPath}`,
      { code, path: lockPath, cause: err },
    );
  }
  // Unknown error — surface to the caller's crash handler with full
  // context so a fresh failure mode does not get silently classified
  // as fatal.
  throw err;
}
