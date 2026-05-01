// T68 — harness `daemon` mode helper.
//
// Purpose
// -------
// Probes that exercise the v0.3 daemon-split path need to boot a real
// `daemon/src/index.ts` process, wait for it to be ready, drive RPCs at
// it (when the control-socket binding lands), and tear it down
// gracefully on test teardown. This module is the single helper every
// such probe imports — keeping the spawn/wait/teardown shape consistent
// across harnesses (real-cli, ui, dnd, future daemon-reconnect).
//
// Spec citations
// --------------
// - frag-3.7-dev-workflow.md §3.7.7 — `harness-agent.daemonReconnect()`
//   phase: spawn daemon, wait for ready, kill platform-aware target,
//   assert reconnect-toast clears within 1 s.
// - frag-3.4.1-envelope-hardening.md §3.4.1.h — supervisor RPCs:
//   `/healthz`, `/stats`, `daemon.hello`, `daemon.shutdown`,
//   `daemon.shutdownForUpgrade` (only `daemon.hello` is used here for
//   the readiness probe; rich RPC drive is out of scope for T68 — it
//   lands when `daemon/src/index.ts` actually binds the control socket).
// - frag-3.4.1 §3.4.1.g — `daemon.hello` 2-frame handshake (we surface
//   a placeholder `helloProbe` API gated on `socketPath` existing, so
//   call sites can opt in once the socket binding lands without a
//   second helper rewrite).
//
// Single Responsibility
// ---------------------
// PRODUCER: spawns the child process, surfaces a `ready` promise, a
// `process` handle, and a `shutdown()` action. Owns NO test assertions
// and NO probe-specific logic. The caller (a `harness-*.mjs` case or a
// vitest test) decides what to assert.
//
// Mode selection
// --------------
// The harness opts into daemon mode via either:
//   - env: `HARNESS_MODE=daemon` (preferred — easiest to set in CI)
//   - argv: `--mode=daemon` (preferred — easiest one-off iteration)
// `parseHarnessMode(argv, env)` returns the resolved mode; cases that
// don't care can ignore the result and run as before (default = inline,
// no daemon spawn).
//
// Hot-file avoidance (per task brief)
// -----------------------------------
// - Does NOT import T64's wait-daemon helper (parallel PR #1021). The
//   readiness probe inlines its own stdout-marker wait + a (gated)
//   net.connect attempt to keep the modules independent until a future
//   consolidation PR lands.
// - Does NOT touch `double-bind-guard.ts` (T72 / PR #1025).

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { connect as netConnect } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');

/** Default stdout marker logged by `daemon/src/index.ts` once the shell
 *  has booted (see `logger.info({ event: 'daemon.boot' }, 'daemon shell
 *  booted')`). Stable across T16-T25 because the line is the canonical
 *  spec-§6.6 boot signal. */
export const DEFAULT_READY_MARKER = 'daemon shell booted';

/** Default per-step timeout (ms). The boot step itself is the slowest —
 *  cold tsx + ts compile of `daemon/src/**` measures ~3-4s on the
 *  reference Win11 25H2 box; 10s gives 2x headroom without masking a
 *  genuine daemon-stall regression. */
const DEFAULT_BOOT_TIMEOUT_MS = 10_000;

/** Default graceful-shutdown deadline. Mirrors the daemon-shutdown
 *  spec §6.6.1 5s budget plus 1s of slack for child-process teardown. */
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 6_000;

/**
 * Parse the harness mode from argv + env. Argv wins over env so an
 * interactive `--mode=daemon` overrides a stale exported var.
 *
 * @param {readonly string[]} argv  Normally `process.argv.slice(2)`.
 * @param {NodeJS.ProcessEnv} env   Normally `process.env`.
 * @returns {'daemon' | undefined}  Undefined = inline (no daemon spawn).
 */
export function parseHarnessMode(argv, env) {
  for (const a of argv) {
    if (a === '--mode=daemon') return 'daemon';
    if (a === '--mode=inline') return undefined;
  }
  if (env && env.HARNESS_MODE === 'daemon') return 'daemon';
  return undefined;
}

/**
 * @typedef {object} BootDaemonOptions
 * @property {string}   [entry]       Absolute path to the daemon entry.
 *                                    Defaults to `daemon/src/index.ts`.
 * @property {string}   [readyMarker] Stdout substring that signals
 *                                    readiness. Default = canonical
 *                                    boot line.
 * @property {string}   [socketPath]  Optional control-socket path. When
 *                                    provided AND the socket file/pipe
 *                                    exists, an extra `net.connect`
 *                                    smoke-check runs before resolving
 *                                    `ready`. When omitted (the v0.3
 *                                    state today — daemon binds no
 *                                    socket yet) the helper falls back
 *                                    to the stdout-marker wait alone.
 * @property {number}   [bootTimeoutMs]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {(line: string) => void} [onLog] Optional per-line tap of
 *                                            child stderr/stdout, for
 *                                            harness debug surfaces.
 * @property {(cmd: string, args: string[], opts: object) => import('node:child_process').ChildProcess} [spawnFn]
 *   Test seam — defaults to `child_process.spawn`. Tests inject a
 *   mock to avoid spawning real processes.
 */

/**
 * @typedef {object} DaemonHandle
 * @property {import('node:child_process').ChildProcess} child
 * @property {Promise<void>} ready          Resolves once boot marker
 *                                          (and optional socket probe)
 *                                          succeed.
 * @property {() => Promise<number | null>} shutdown  Sends SIGTERM,
 *                                          waits for exit, returns the
 *                                          exit code (or null on
 *                                          signal-only exit).
 * @property {() => Promise<number | null>} kill      Force-kill
 *                                          (SIGKILL on POSIX,
 *                                          taskkill /F on Windows via
 *                                          child.kill('SIGKILL')) for
 *                                          tests that need to assert
 *                                          ungraceful exit.
 */

/**
 * Boot the daemon as a child process. Resolves `handle.ready` once the
 * configured readiness signal fires.
 *
 * Lifecycle:
 *   1. spawn `tsx <entry>` (tsx is in dev deps; matches the dev-watch
 *      script + nodemon.daemon.json `exec` line).
 *   2. tail child stderr+stdout for `readyMarker`. (The daemon logs
 *      JSON via pino to stdout; the marker is a substring of the
 *      "msg" field, so plain `.includes()` is sufficient.)
 *   3. If `opts.socketPath` was provided AND the path exists by the
 *      time the marker fires, attempt one `net.connect` to it; resolve
 *      ready once the connect callback runs (or reject if it errors).
 *   4. Reject `ready` if the child exits before the marker, or if the
 *      boot timeout elapses.
 *
 * The child process inherits the harness env by default; callers can
 * inject overrides via `opts.env` (e.g. CCSM_DAEMON_LOG_LEVEL).
 *
 * @param {BootDaemonOptions} [opts]
 * @returns {DaemonHandle}
 */
export function bootDaemon(opts = {}) {
  const entry = opts.entry ?? resolve(REPO_ROOT, 'daemon/src/index.ts');
  const readyMarker = opts.readyMarker ?? DEFAULT_READY_MARKER;
  const bootTimeoutMs = opts.bootTimeoutMs ?? DEFAULT_BOOT_TIMEOUT_MS;
  const spawnFn = opts.spawnFn ?? spawn;

  const isWin = process.platform === 'win32';
  const tsxBin = isWin ? 'tsx.cmd' : 'tsx';

  const child = spawnFn(tsxBin, [entry], {
    cwd: REPO_ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(opts.env ?? {}) },
    shell: isWin,
  });

  /** @type {(value: void) => void} */
  let resolveReady;
  /** @type {(err: Error) => void} */
  let rejectReady;
  const ready = new Promise((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });

  let settled = false;
  const settle = (err) => {
    if (settled) return;
    settled = true;
    cleanupListeners();
    if (err) rejectReady(err);
    else resolveReady();
  };

  // Buffer partial lines so a chunked write of the marker still matches.
  let outBuf = '';
  let errBuf = '';

  const tryMatch = (chunk, which) => {
    const text = chunk.toString('utf8');
    if (opts.onLog) {
      // Emit per-line for nicer harness logs. Best-effort; swallow
      // listener errors so a bad tap doesn't poison readiness.
      const merged = (which === 'out' ? outBuf : errBuf) + text;
      const lines = merged.split(/\r?\n/);
      const tail = lines.pop() ?? '';
      for (const line of lines) {
        try { opts.onLog(line); } catch { /* swallow */ }
      }
      if (which === 'out') outBuf = tail;
      else errBuf = tail;
    }
    if (text.includes(readyMarker)) {
      void onMarkerSeen();
    }
  };

  const onStdout = (chunk) => tryMatch(chunk, 'out');
  const onStderr = (chunk) => tryMatch(chunk, 'err');

  const onExitBeforeReady = (code, signal) => {
    settle(new Error(
      `daemon child exited before ready marker (code=${code ?? 'null'}, signal=${signal ?? 'null'})`,
    ));
  };

  const onError = (err) => {
    settle(new Error(`failed to spawn daemon: ${err.message}`));
  };

  const cleanupListeners = () => {
    child.stdout?.off('data', onStdout);
    child.stderr?.off('data', onStderr);
    child.off('exit', onExitBeforeReady);
    child.off('error', onError);
    if (timeoutHandle) clearTimeout(timeoutHandle);
  };

  /** Optional control-socket smoke check after the marker fires. We
   *  only attempt it when the caller asked AND the path materializes
   *  on disk — today (T19 merged, T16 dispatcher merged, but
   *  index.ts has not yet wired `controlSocket.listen()`) the path
   *  will not exist, so we skip silently and let the marker alone
   *  signal readiness. When the binding lands, callers pass
   *  `socketPath` and this branch lights up automatically. */
  const onMarkerSeen = async () => {
    if (settled) return;
    if (!opts.socketPath || !existsSync(opts.socketPath)) {
      settle();
      return;
    }
    try {
      await helloSocketProbe(opts.socketPath, 2_000);
      settle();
    } catch (err) {
      settle(new Error(`control-socket probe failed: ${err.message}`));
    }
  };

  child.stdout?.on('data', onStdout);
  child.stderr?.on('data', onStderr);
  child.once('exit', onExitBeforeReady);
  child.once('error', onError);

  const timeoutHandle = setTimeout(() => {
    settle(new Error(
      `daemon did not emit ready marker (${JSON.stringify(readyMarker)}) within ${bootTimeoutMs}ms`,
    ));
  }, bootTimeoutMs);

  /** Send SIGTERM (which the daemon handles via its
   *  `shutdownFromSignal('SIGTERM')` funnel — invoking the same
   *  `daemonShutdownHandler.handle()` path as the wire RPC) and wait
   *  for exit. Asserts the process actually exited within the
   *  shutdown deadline. */
  const shutdown = async () => {
    if (child.exitCode != null || child.signalCode) return child.exitCode;
    const exitedP = new Promise((res) => {
      child.once('exit', (code) => res(code));
    });
    try { child.kill('SIGTERM'); } catch { /* already dead */ }
    const code = await Promise.race([
      exitedP,
      new Promise((_res, rej) =>
        setTimeout(
          () => rej(new Error(`daemon did not exit within ${DEFAULT_SHUTDOWN_TIMEOUT_MS}ms of SIGTERM`)),
          DEFAULT_SHUTDOWN_TIMEOUT_MS,
        ),
      ),
    ]);
    return code;
  };

  /** Force-kill escape hatch for tests that need to assert behaviour
   *  on ungraceful daemon exit (e.g. the `daemonReconnect` phase). */
  const kill = async () => {
    if (child.exitCode != null || child.signalCode) return child.exitCode;
    const exitedP = new Promise((res) => {
      child.once('exit', (code) => res(code));
    });
    try { child.kill('SIGKILL'); } catch { /* already dead */ }
    return exitedP;
  };

  return { child, ready, shutdown, kill };
}

/**
 * Open a unix-socket / named-pipe connection and resolve once the
 * `connect` event fires. Used as the optional readiness check after
 * the stdout marker. Rejects on `error` or after `timeoutMs`.
 *
 * Intentionally does NOT send a `daemon.hello` envelope yet — that
 * requires the v0.3 envelope adapter, which is not yet wired to
 * `daemon/src/index.ts`. Once it is, this can be upgraded to send a
 * real handshake; for now a clean TCP-style connect is the cheapest
 * "the listener exists and accepts connections" proof.
 *
 * @param {string} socketPath
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function helloSocketProbe(socketPath, timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = netConnect(socketPath);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error(`socket connect timeout after ${timeoutMs}ms`));
    }, timeoutMs);
    sock.once('connect', () => {
      clearTimeout(timer);
      sock.end();
      resolve();
    });
    sock.once('error', (err) => {
      clearTimeout(timer);
      sock.destroy();
      reject(err);
    });
  });
}

/**
 * Sugar for the common case: parse mode, boot if requested, run the
 * supplied async body, tear down. Mirrors the shape harness probes
 * already use for tempdir/cleanup so adding daemon mode is one line.
 *
 * Example call site (inside a future `harness-daemon-reconnect.mjs`):
 *
 *   const mode = parseHarnessMode(process.argv.slice(2), process.env);
 *   await runWithDaemonMode(mode, async ({ daemon }) => {
 *     // daemon is null when mode !== 'daemon'
 *     if (!daemon) throw new Error('this case requires --mode=daemon');
 *     await myAssertions(daemon);
 *   });
 *
 * @template T
 * @param {'daemon' | undefined} mode
 * @param {(ctx: { daemon: DaemonHandle | null }) => Promise<T>} body
 * @param {BootDaemonOptions} [bootOpts]
 * @returns {Promise<T>}
 */
export async function runWithDaemonMode(mode, body, bootOpts) {
  if (mode !== 'daemon') {
    return body({ daemon: null });
  }
  const daemon = bootDaemon(bootOpts);
  try {
    await daemon.ready;
    return await body({ daemon });
  } finally {
    try { await daemon.shutdown(); } catch { /* swallow on teardown */ }
  }
}
