// Pure helpers for scripts/postinstall.mjs.
//
// Two concerns live here, both extracted so they're unit-testable
// without spawning a real child process or touching node_modules:
//
//   1. `rebuildWithRetry` (Task #641 Layer 1): EPERM/EBUSY retry-once
//      policy for `@electron/rebuild`. Covers transient locks (AV scan,
//      Windows indexer, stale electron.exe / vsbuild process from a
//      previous run still releasing its handle on the .node file).
//
//   2. `checkNoElectronRunning` (Task #643): root-cause guard. When
//      a user already has the ccsm app running (post-install upgrade)
//      or a stale `npm run dev` Electron child still alive, the .node
//      file is locked by the OS. @electron/rebuild's first step is
//      `unlink(.node)` -> EPERM on Windows / EBUSY on Linux. The
//      retry loop in (1) doesn't help because the offending process
//      is the user's own Electron, not a transient AV/indexer lock.
//      Mode-3 pattern (vscode-ripgrep / node-pty): probe with
//      `tasklist` / `pgrep` BEFORE the rebuild, fail fast with a
//      precise message. This is the actual root-cause fix for
//      #575-style EPERM dogfood reports.
//
// Escape hatch for (2): CCSM_POSTINSTALL_SKIP_PROCESS_CHECK=1 bypasses
// the check (CI sets this defensively — CI has no GUI ccsm, but we
// don't want a pathological runner with a leftover Electron to block
// green builds).
//
// Usage from postinstall.mjs:
//   import { checkNoElectronRunning, rebuildWithRetry, blockingSleep }
//     from './postinstall-helpers.mjs';
//   const guard = checkNoElectronRunning();
//   if (guard.blocked) { console.error(guard.message); process.exit(1); }
//   const result = rebuildWithRetry({ ...config, spawn: spawnSync, sleep: blockingSleep });

import { spawnSync } from 'node:child_process';
import process from 'node:process';

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

/**
 * Probe for running ccsm/Electron processes that would lock the
 * better-sqlite3 / node-pty .node files during rebuild.
 *
 * Returns `{ blocked: false }` when no offending process is found, or
 * `{ blocked: true, message: string, pids: number[] }` when at least
 * one is. Caller decides whether to exit.
 *
 * The `deps` parameter exists purely so unit tests can inject a fake
 * `spawnSync` and `platform` without monkey-patching `node:child_process`.
 *
 * @param {object} [deps]
 * @param {NodeJS.Platform} [deps.platform] override for tests
 * @param {typeof spawnSync} [deps.spawn] override for tests
 * @param {NodeJS.ProcessEnv} [deps.env] override for tests
 * @returns {{ blocked: boolean, message?: string, pids?: number[], skipped?: boolean }}
 */
export function checkNoElectronRunning(deps = {}) {
  const platform = deps.platform ?? process.platform;
  const spawn = deps.spawn ?? spawnSync;
  const env = deps.env ?? process.env;

  if (env.CCSM_POSTINSTALL_SKIP_PROCESS_CHECK === '1') {
    return { blocked: false, skipped: true };
  }

  if (platform === 'win32') {
    return checkWindows(spawn);
  }
  // macOS + Linux share the same pgrep contract.
  return checkUnix(spawn);
}

/**
 * Format the user-facing error message for a blocked check. Shared so
 * postinstall.mjs and tests render identical text.
 *
 * @param {number[]} pids
 * @returns {string}
 */
export function formatBlockedMessage(pids) {
  const pidList = pids.length > 0 ? pids.join(', ') : 'unknown';
  return [
    '',
    `[postinstall] Detected ccsm/Electron processes still running (PIDs: ${pidList}).`,
    '[postinstall] Please close all ccsm windows (and stop any `npm run dev`',
    '[postinstall] Electron child) and re-run `npm install`.',
    '[postinstall]',
    '[postinstall] This is to prevent EPERM during native module rebuild —',
    '[postinstall] a running Electron locks node_modules/better-sqlite3/build/',
    '[postinstall] Release/better_sqlite3.node so @electron/rebuild cannot',
    '[postinstall] unlink it. See Task #643.',
    '[postinstall]',
    '[postinstall] Override (CI only, not recommended on dev machines):',
    '[postinstall]   CCSM_POSTINSTALL_SKIP_PROCESS_CHECK=1 npm install',
    '',
  ].join('\n');
}

// --- internals ---------------------------------------------------------

function checkWindows(spawn) {
  // tasklist /FI "IMAGENAME eq <name>" /FO CSV /NH prints one CSV row
  // per match, or a single line "INFO: No tasks are running which match
  // the specified criteria." when there's no match. Exit code is 0 in
  // both cases on Windows 10/11, so we parse stdout rather than rely on
  // status.
  const names = ['electron.exe', 'ccsm.exe'];
  const pids = [];
  for (const name of names) {
    const res = spawn(
      'tasklist',
      ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'],
      { encoding: 'utf8' },
    );
    if (res.error || typeof res.status !== 'number' || res.status !== 0) {
      // tasklist itself failing (missing on PATH, locked-down env) is
      // not a reason to block install. Warn-and-continue is safer than
      // false-positive blocking.
      continue;
    }
    const out = String(res.stdout ?? '');
    if (/INFO: No tasks/i.test(out) || out.trim().length === 0) {
      continue;
    }
    pids.push(...parseTasklistCsvPids(out));
  }
  if (pids.length === 0) {
    return { blocked: false };
  }
  const unique = [...new Set(pids)].sort((a, b) => a - b);
  return {
    blocked: true,
    pids: unique,
    message: formatBlockedMessage(unique),
  };
}

function checkUnix(spawn) {
  // pgrep returns 0 when matches are found, 1 when none, >1 on error.
  // -f matches against the full command line so we can target the
  // ccsm-specific Electron arg or the packaged binary basename.
  // Patterns:
  //   - `electron.*ccsm`  : `npm run dev` style (electron <ccsm-root>)
  //   - `ccsm$`           : packaged Linux/macOS binary basename
  const patterns = ['electron.*ccsm', 'ccsm$'];
  const pids = [];
  // Also exclude the current process and any parent shell — the user
  // is running `npm install`, which itself may have "ccsm" in its
  // working-dir argv. pgrep's -f matches argv but does not include cwd,
  // so this is mostly defensive.
  for (const pattern of patterns) {
    const res = spawn('pgrep', ['-f', pattern], { encoding: 'utf8' });
    if (res.error) {
      // pgrep missing (rare on macOS/Linux) → can't check, don't block.
      continue;
    }
    if (typeof res.status !== 'number') {
      continue;
    }
    if (res.status === 1) {
      // No matches.
      continue;
    }
    if (res.status !== 0) {
      // Other error; skip rather than block.
      continue;
    }
    const out = String(res.stdout ?? '');
    pids.push(...parsePgrepPids(out));
  }
  // Filter out our own PID and direct parent — false positives are
  // possible if the install was launched from inside a "ccsm" cwd.
  const self = process.pid;
  const ppid = typeof process.ppid === 'number' ? process.ppid : -1;
  const filtered = pids.filter((p) => p !== self && p !== ppid);
  if (filtered.length === 0) {
    return { blocked: false };
  }
  const unique = [...new Set(filtered)].sort((a, b) => a - b);
  return {
    blocked: true,
    pids: unique,
    message: formatBlockedMessage(unique),
  };
}

/**
 * Parse PIDs from `tasklist /FO CSV /NH` output. Each row looks like:
 *   "electron.exe","12345","Console","1","123,456 K"
 * We pull field index 1 (PID) per row.
 *
 * Exported for tests.
 *
 * @param {string} stdout
 * @returns {number[]}
 */
export function parseTasklistCsvPids(stdout) {
  const pids = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^INFO:/i.test(trimmed)) continue;
    // Naive CSV split is fine — tasklist quotes every field and the
    // memory column ("123,456 K") is the only one with an internal
    // comma but it's also quoted, so splitting on `","` works.
    const fields = trimmed.replace(/^"|"$/g, '').split('","');
    if (fields.length < 2) continue;
    const pid = Number.parseInt(fields[1], 10);
    if (Number.isFinite(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}

/**
 * Parse PIDs from `pgrep -f <pattern>` stdout (one PID per line).
 *
 * Exported for tests.
 *
 * @param {string} stdout
 * @returns {number[]}
 */
export function parsePgrepPids(stdout) {
  const pids = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const pid = Number.parseInt(trimmed, 10);
    if (Number.isFinite(pid) && pid > 0) {
      pids.push(pid);
    }
  }
  return pids;
}
