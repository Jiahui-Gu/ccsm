// Pure helpers for scripts/postinstall.mjs (Task #641 Layer 1).
// Extracted so the EPERM/EBUSY retry-once policy is unit-testable
// without spawning a real child process or touching node_modules.
//
// Usage from postinstall.mjs:
//   import { rebuildWithRetry } from './postinstall-helpers.mjs';
//   const ok = rebuildWithRetry({ ...config, spawn: spawnSync, sleep: blockingSleep });

/**
 * Block the calling thread for `ms` milliseconds. Used by postinstall
 * (which runs to completion in a child process — no event loop concerns).
 *
 * Atomics.wait on a fresh SharedArrayBuffer is a portable, dependency-free
 * way to sleep without busy-spinning the CPU.
 *
 * @param {number} ms
 */
export function blockingSleep(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.max(0, ms | 0));
}

/**
 * Run `@electron/rebuild` for one module, with a Windows-only retry-once
 * policy on non-zero exit (covers EPERM/EBUSY when a stale electron.exe /
 * vsbuild process from a previous run holds an open handle on the .node
 * file — see Task #641 / dogfood #575).
 *
 * Pure: takes injected spawn + sleep, returns a result the caller consumes.
 * NEVER calls process.exit — the caller (postinstall.mjs) decides how to
 * react to a final non-zero status.
 *
 * @param {object} cfg
 * @param {string} cfg.rebuildBin           Absolute path to electron-rebuild bin.
 * @param {string} cfg.moduleName           e.g. 'better-sqlite3'.
 * @param {string} cfg.cwd                  Repo root.
 * @param {boolean} cfg.isWindows           From `process.platform === 'win32'`.
 * @param {boolean} cfg.allowFailure        node-pty path: prebuild fallback exists, don't retry.
 * @param {number} [cfg.retryDelayMs=5000]  Sleep before retry. Tests pass 0.
 * @param {(bin: string, args: string[], opts: object) => { status: number | null, error?: Error, signal?: NodeJS.Signals | null }} cfg.spawn
 *   spawnSync-shaped callable.
 * @param {(ms: number) => void} cfg.sleep  blocking sleep, see blockingSleep.
 * @returns {{ status: number | null, error?: Error, signal?: NodeJS.Signals | null, attempts: number }}
 */
export function rebuildWithRetry(cfg) {
  const {
    rebuildBin,
    moduleName,
    cwd,
    isWindows,
    allowFailure,
    retryDelayMs = 5000,
    spawn,
    sleep,
  } = cfg;
  const args = ['-f', '-o', moduleName, '--build-from-source'];
  const opts = { stdio: 'inherit', shell: isWindows, cwd };

  let attempts = 1;
  const first = spawn(rebuildBin, args, opts);
  // Hard failures (spawn errored or killed by signal) are not retry-able —
  // they indicate something fundamentally wrong (missing bin, OOM-killer,
  // user pressed ^C). Surface them as-is.
  if (first.error || first.signal) {
    return { ...first, attempts };
  }
  // Success on first try, or non-Windows (no EPERM to retry around), or the
  // caller marked this module as failure-tolerant (node-pty has a prebuild
  // fallback) — return whatever we got.
  if (
    first.status === 0 ||
    !isWindows ||
    allowFailure ||
    typeof first.status !== 'number'
  ) {
    return { ...first, attempts };
  }

  // Windows + non-zero + must-succeed → wait, retry once.
  sleep(retryDelayMs);
  attempts = 2;
  const retry = spawn(rebuildBin, args, opts);
  return { ...retry, attempts };
}
