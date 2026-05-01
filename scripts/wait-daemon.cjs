#!/usr/bin/env node
// T64 — wait-daemon.cjs (frag-3.7 §3.7.2 + Task 1).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.7-dev-workflow.md L85, L91-105,
//     L628-636: `scripts/wait-daemon.cjs` is the dev-script gate that BLOCKS
//     `dev:app` until the daemon process has written its `daemon.lock` to the
//     OS-native data root. Replaces the round-1 `wait-on tcp:127.0.0.1:0`
//     no-op which let Electron race the named-pipe bind and dumped every dev
//     boot into the auto-reconnect loop.
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.4: the daemon writes `<dataRoot>/daemon.lock` via `proper-lockfile`
//     during boot — single source of truth for "daemon is ready to accept
//     RPCs". No new daemon-side work needed.
//   - docs/superpowers/specs/v0.3-fragments/frag-12-traceability.md r5 lock #2
//     and daemon/src/sockets/runtime-root.ts: canonical `<dataRoot>` resolver
//     uses LOCALAPPDATA/Library/Application Support/(XDG_DATA_HOME ??
//     ~/.local/share). frag-3.7's inline path snippet (APPDATA on Win,
//     XDG_CONFIG_HOME on Linux) is older and conflicts with the runtime-root
//     resolver — we follow the runtime-root resolver because (a) it is the
//     module the daemon actually uses to write the lockfile, and (b) frag-12
//     r5 lock #2 explicitly canonicalises the data-root layout. Drift between
//     this script's path derivation and runtime-root.ts is guarded by a unit
//     test (tests/wait-daemon.test.ts).
//
// Probe path decision (Layer 1):
//   The Task #1021 brief proposes a control-socket `daemon.hello` or
//   `/healthz` round-trip. Spec frag-3.7 §3.7.2 explicitly mandates a
//   lockfile-existence probe instead, for three reasons captured in the spec:
//     1. The lockfile is the single load-bearing "daemon process is up"
//        signal already mandated by frag-6-7 §6.4 — no new contract.
//     2. The control-socket bind happens AFTER lockfile acquisition in the
//        daemon boot order (frag-6-7 §6.1 "cold-start"), so a lockfile probe
//        is strictly not-before "socket is bindable" — equivalent guarantee
//        for the dev-script use case.
//     3. Polling a file is zero-deps and works in a fresh CI clone with no
//        workspace install (the brief's "zero-workspace-deps" requirement).
//        A control-socket round-trip would force this script to either
//        duplicate the envelope/HMAC framing OR import @ccsm/daemon — both
//        are violations of the standalone-helper contract.
//   We follow the spec.
//
// CLI:
//   node scripts/wait-daemon.cjs [--timeout-ms <N>] [--poll-interval-ms <N>] [--verbose]
//
// Exit codes:
//   0  daemon.lock present (daemon ready)
//   1  timeout
//   2  bad CLI argument or unrecoverable error
//
// Single Responsibility:
//   - Producer of one ready-or-timeout signal (exit code).
//   - Pure path derivation + fs.statSync polling. No envelope, no socket.
//
// Usage from package.json:
//   "dev:app": "node scripts/wait-daemon.cjs && tsc -p tsconfig.electron.json && cross-env CCSM_DAEMON_DEV=1 electron ."

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_POLL_INTERVAL_MS = 200;
const LOCKFILE_NAME = 'daemon.lock';

/**
 * Resolve `<dataRoot>` for the current platform.
 *
 * MUST stay byte-for-byte identical to `resolveDataRoot()` in
 * `daemon/src/sockets/runtime-root.ts`. Drift is caught by
 * `tests/wait-daemon.test.ts` (drift guard).
 *
 * Why duplicate vs import: this script is a CI-friendly standalone helper
 * with zero workspace dependencies (frag-3.7 §3.7.2 — runs before
 * `npm install` on first contributor checkout in some flows; runs from
 * fresh clones in CI before workspace symlinks exist).
 */
function resolveDataRoot(platform, env, home) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local && local.length > 0) return path.join(local, 'ccsm');
    return path.join(home, 'AppData', 'Local', 'ccsm');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ccsm');
  }
  // Linux + every other POSIX
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) return path.join(xdgData, 'ccsm');
  return path.join(home, '.local', 'share', 'ccsm');
}

/** Resolve the full lockfile path (`<dataRoot>/daemon.lock`). */
function resolveLockfilePath(opts) {
  const platform = (opts && opts.platform) || process.platform;
  const env = (opts && opts.env) || process.env;
  const home = (opts && opts.home) || os.homedir();
  return path.join(resolveDataRoot(platform, env, home), LOCKFILE_NAME);
}

/**
 * Parse argv (skipping node + script). Returns `{ ok, value, error }`.
 * Strict: unknown flag → error. Negative / non-finite numbers → error.
 */
function parseArgs(argv) {
  const out = {
    timeoutMs: DEFAULT_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    verbose: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--verbose' || arg === '-v') {
      out.verbose = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      return { ok: false, help: true };
    }
    if (arg === '--timeout-ms' || arg === '--poll-interval-ms') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ok: false, error: `${arg} requires a value` };
      }
      const n = Number(next);
      if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
        return { ok: false, error: `${arg} expects a positive integer, got ${JSON.stringify(next)}` };
      }
      if (arg === '--timeout-ms') out.timeoutMs = n;
      else out.pollIntervalMs = n;
      i += 1;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }
  if (out.pollIntervalMs > out.timeoutMs) {
    return { ok: false, error: `--poll-interval-ms (${out.pollIntervalMs}) exceeds --timeout-ms (${out.timeoutMs})` };
  }
  return { ok: true, value: out };
}

/** Synchronous existence check. We accept anything (file / lock-dir from
 *  proper-lockfile) — proper-lockfile creates a directory; older stubs may
 *  create a regular file. Existence is the load-bearing signal; type is
 *  out of scope here. */
function lockfileExists(lockPath) {
  try {
    fs.statSync(lockPath);
    return true;
  } catch (err) {
    if (err && err.code === 'ENOENT') return false;
    // EACCES / EPERM / other unexpected fs error: surface to caller.
    throw err;
  }
}

/**
 * Poll for the lockfile. Returns a promise resolving to `{ ready, elapsedMs }`.
 *
 * `clock.now()` and `clock.sleep(ms)` are injected so tests can drive
 * deterministic time without sleeping wall-clock seconds. Production
 * defaults: `Date.now` + `setTimeout`.
 */
async function waitForLockfile(opts) {
  const lockPath = opts.lockfilePath;
  const timeoutMs = opts.timeoutMs;
  const pollIntervalMs = opts.pollIntervalMs;
  const verbose = !!opts.verbose;
  const log = opts.log || ((msg) => process.stderr.write(`${msg}\n`));
  const now = (opts.clock && opts.clock.now) || Date.now;
  const sleep = (opts.clock && opts.clock.sleep) ||
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const exists = opts.exists || lockfileExists;

  const started = now();
  let polls = 0;
  for (;;) {
    polls += 1;
    let present = false;
    try {
      present = exists(lockPath);
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      log(`wait-daemon: fs error probing ${lockPath}: ${msg}`);
      return { ready: false, elapsedMs: now() - started, polls, error: err };
    }
    if (present) {
      const elapsedMs = now() - started;
      if (verbose) {
        log(`wait-daemon: ready after ${elapsedMs}ms (${polls} poll${polls === 1 ? '' : 's'})`);
      }
      return { ready: true, elapsedMs, polls };
    }
    const elapsedMs = now() - started;
    if (elapsedMs >= timeoutMs) {
      log(
        `wait-daemon: timeout after ${elapsedMs}ms waiting for ${lockPath} ` +
          `(daemon did not write daemon.lock — is dev:daemon running?)`,
      );
      return { ready: false, elapsedMs, polls };
    }
    if (verbose) {
      log(`wait-daemon: poll #${polls} miss at +${elapsedMs}ms (${lockPath})`);
    }
    // Sleep, but never overshoot the timeout deadline.
    const remainingMs = timeoutMs - elapsedMs;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
}

const HELP_TEXT = `Usage: node scripts/wait-daemon.cjs [options]

Blocks until the ccsm daemon writes <dataRoot>/daemon.lock at boot
(frag-3.7 §3.7.2 + frag-6-7 §6.4).

Options:
  --timeout-ms <N>        Max wait in milliseconds (default ${DEFAULT_TIMEOUT_MS}).
  --poll-interval-ms <N>  Poll cadence in milliseconds (default ${DEFAULT_POLL_INTERVAL_MS}).
  --verbose, -v           Log each poll to stderr.
  --help, -h              Print this message and exit 2.

Exit codes:
  0  daemon ready
  1  timeout
  2  bad argument
`;

async function main(argv) {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    if (parsed.help) {
      process.stderr.write(HELP_TEXT);
      return 2;
    }
    process.stderr.write(`wait-daemon: ${parsed.error}\n${HELP_TEXT}`);
    return 2;
  }
  const opts = parsed.value;
  const lockfilePath = resolveLockfilePath();
  if (opts.verbose) {
    process.stderr.write(
      `wait-daemon: probing ${lockfilePath} (timeout ${opts.timeoutMs}ms, poll ${opts.pollIntervalMs}ms)\n`,
    );
  }
  const result = await waitForLockfile({
    lockfilePath,
    timeoutMs: opts.timeoutMs,
    pollIntervalMs: opts.pollIntervalMs,
    verbose: opts.verbose,
  });
  return result.ready ? 0 : 1;
}

// Export internals for unit tests. Detect "run as script" via require.main.
module.exports = {
  resolveDataRoot,
  resolveLockfilePath,
  parseArgs,
  waitForLockfile,
  lockfileExists,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  LOCKFILE_NAME,
};

if (require.main === module) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (err) => {
      process.stderr.write(`wait-daemon: unexpected error: ${err && err.stack ? err.stack : String(err)}\n`);
      process.exit(2);
    },
  );
}
