// Spawn the v0.3 daemon child process from the Electron main process and
// expose its loopback Connect-RPC port to the rest of main (which forwards
// it to the renderer via a tiny preload bridge).
//
// Wave 1 protocol with the daemon dev (dev-A):
//   * The daemon prints exactly one line `PORT=<n>` on stdout when its
//     loopback HTTP server is bound and ready to accept connections.
//   * Anything before / after that line is treated as opaque log noise and
//     forwarded to main's stderr.
//   * The daemon exits cleanly on SIGTERM. We send SIGTERM during
//     `app.on('before-quit')` (see electron/lifecycle/appLifecycle.ts).
//
// Why `child_process.spawn` and not `fork`:
//   * The daemon is a standalone Node binary in v0.3 — it must be
//     spawnable by the eventual headless CLI too (see frozen ship goal).
//     `fork` requires the child to be a Node script of the SAME runtime,
//     which prevents shipping a packaged daemon binary later.
//   * We don't need the IPC channel that `fork` opens; the wire is
//     loopback HTTP + Connect-RPC.
//
// Failure modes (best-effort, no fancy retry — the renderer surfaces a
// "daemon failed to start" toast in the UI later):
//   * spawn ENOENT → reject the ready promise (kind: 'spawn-failed').
//   * exit before PORT line → reject the ready promise (kind: 'early-exit').
//   * stdout PORT line malformed → reject the ready promise (kind: 'bad-port-line').
//   * READY_TIMEOUT_MS elapsed without PORT line → reject + SIGKILL child
//     (kind: 'timeout'). Cold-launch budget is 500ms p95; 10s is the hard
//     ceiling above which we declare the spawn dead and let the renderer
//     surface a toast (PR #597 / spec §5.3.3 PR-3 Option C).

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

/** Hard ceiling for the daemon's cold-launch ready signal. Cold-launch
 *  budget under Option C is 500ms p95; 10s is the abort threshold above
 *  which we kill the child and surface a typed error to the caller. */
export const READY_TIMEOUT_MS = 10_000;

/** Discriminated union of spawn-time failure reasons. Callers (main.ts,
 *  preload bridge, future renderer toast) switch on `kind` instead of
 *  string-matching the message. */
export type DaemonSpawnFailureKind =
  | 'spawn-failed' // spawn() itself failed (ENOENT, EACCES, etc.)
  | 'early-exit' // child exited before printing PORT=<n>
  | 'bad-port-line' // first stdout line wasn't `PORT=<valid integer>`
  | 'timeout' // READY_TIMEOUT_MS elapsed with no PORT line
  | 'no-pipes'; // spawn returned without stdout/stderr pipes

/** Typed error thrown / rejected from spawnDaemon. Use `instanceof
 *  DaemonSpawnError` + switch on `.kind` for handling. */
export class DaemonSpawnError extends Error {
  public readonly kind: DaemonSpawnFailureKind;
  /** Original cause where applicable (spawn errno, exit code/signal, raw
   *  stdout line). Stored loosely for log forwarding. */
  public readonly detail: Record<string, unknown>;

  constructor(
    kind: DaemonSpawnFailureKind,
    message: string,
    detail: Record<string, unknown> = {},
  ) {
    super(`[daemon-spawner] ${message}`);
    this.name = 'DaemonSpawnError';
    this.kind = kind;
    this.detail = detail;
  }
}

let child: ChildProcess | null = null;
let port: number | null = null;
let readyPromise: Promise<number> | null = null;

/** Path to the daemon entrypoint. dev-A owns this file; in dev we run the
 *  same `dist/daemon/main.js` that the prod bundle ships. Override with
 *  `CCSM_DAEMON_ENTRY` for tests / one-off probes. */
function resolveDaemonEntry(): string {
  const override = process.env.CCSM_DAEMON_ENTRY;
  if (override && override.length > 0) return override;
  // __dirname is .../dist/electron, so daemon entry sits at
  // .../dist/daemon/main.js after `tsc -p tsconfig.daemon.json`. Wave-2 A
  // fix: was `index.js` (wave-1 placeholder name) but the actual entry
  // emitted by tsconfig.daemon is main.js — daemon never had an index.ts.
  return path.join(__dirname, '..', 'daemon', 'main.js');
}

/** Spawn the daemon if it isn't already running, return the resolved port.
 *  Idempotent — repeat calls return the same promise. */
export function spawnDaemon(): Promise<number> {
  if (readyPromise) return readyPromise;

  const entry = resolveDaemonEntry();
  // Pick the runtime that matches our prebuilt native modules' ABI.
  //
  // Native deps (better-sqlite3, node-pty) are rebuilt against Electron's
  // ABI (NODE_MODULE_VERSION = electron's V8 build, e.g. 145 for E41).
  // The system `node` on PATH usually has a different ABI (127 for Node
  // 22), so spawning the daemon under it `require('better-sqlite3')` blows
  // up at module load with `compiled against a different Node.js version`.
  //
  // Default: run the daemon under our own Electron binary in
  // ELECTRON_RUN_AS_NODE mode — same V8, same ABI, zero rebuild needed.
  // Override with `CCSM_DAEMON_NODE=<absolute path>` for packaged headless
  // CLI builds that ship a separate Node runtime.
  const useElectronAsNode = !process.env.CCSM_DAEMON_NODE;
  const nodeBin = process.env.CCSM_DAEMON_NODE || process.execPath;

  const proc = spawn(nodeBin, [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      // ELECTRON_RUN_AS_NODE=1 makes the Electron binary skip the Chromium
      // bootstrap and behave as plain Node — the only knob that lets us
      // reuse `process.execPath` for a Node-style child without ABI drift.
      ...(useElectronAsNode ? { ELECTRON_RUN_AS_NODE: '1' } : {}),
      // Tell the daemon to bind a random free port on 127.0.0.1; it must
      // print `PORT=<n>` on stdout once ready.
      CCSM_DAEMON_BIND: '127.0.0.1:0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  child = proc;
  // stdio configured to pipe stdout+stderr above; assert non-null for the
  // type system. spawn's overload picks ChildProcessByStdio<null,Readable,
  // Readable> here so .stdout / .stderr are `Readable | null` in the
  // generic ChildProcess view we keep on the module-level holder.
  const stdout = proc.stdout;
  const stderr = proc.stderr;
  if (!stdout || !stderr) {
    return Promise.reject(
      new DaemonSpawnError(
        'no-pipes',
        'spawn returned no stdout/stderr pipes',
      ),
    );
  }

  readyPromise = new Promise<number>((resolve, reject) => {
    let resolved = false;
    let stdoutBuf = '';
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;

    const finishReject = (err: DaemonSpawnError) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      reject(err);
    };
    const finishResolve = (n: number) => {
      if (resolved) return;
      resolved = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      resolve(n);
    };

    // 10s ready-signal timeout (Option C). On fire we SIGKILL the child
    // (SIGTERM may not be honored if the daemon is wedged in startup),
    // null out module state, and reject with kind: 'timeout'.
    timeoutHandle = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* best-effort */
      }
      child = null;
      port = null;
      finishReject(
        new DaemonSpawnError(
          'timeout',
          `daemon did not emit PORT=<n> within ${READY_TIMEOUT_MS}ms`,
          { timeoutMs: READY_TIMEOUT_MS },
        ),
      );
    }, READY_TIMEOUT_MS);
    // Don't keep the event loop alive for this timer — main process has
    // its own lifecycle holders. unref() is a no-op if not supported.
    if (typeof timeoutHandle.unref === 'function') {
      timeoutHandle.unref();
    }

    const onStdout = (chunk: Buffer) => {
      stdoutBuf += chunk.toString('utf8');
      // First newline-terminated line is the contract; subsequent lines
      // are forwarded as logs.
      const nl = stdoutBuf.indexOf('\n');
      if (nl < 0) return;
      const firstLine = stdoutBuf.slice(0, nl).trim();
      const rest = stdoutBuf.slice(nl + 1);
      stdoutBuf = '';
      const m = /^PORT=(\d+)$/.exec(firstLine);
      if (!m) {
        finishReject(
          new DaemonSpawnError(
            'bad-port-line',
            `expected first stdout line "PORT=<n>", got ${JSON.stringify(firstLine)}`,
            { line: firstLine },
          ),
        );
        return;
      }
      const parsed = Number(m[1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        finishReject(
          new DaemonSpawnError(
            'bad-port-line',
            `invalid port from daemon: ${JSON.stringify(firstLine)}`,
            { line: firstLine, parsed },
          ),
        );
        return;
      }
      port = parsed;
      // Swap to a passthrough handler for any further stdout (logs).
      stdout.removeListener('data', onStdout);
      stdout.on('data', (b: Buffer) => {
        process.stderr.write('[daemon stdout] ' + b.toString('utf8'));
      });
      if (rest.length > 0) {
        process.stderr.write('[daemon stdout] ' + rest);
      }
      console.log(`[daemon-spawner] daemon ready on port ${parsed}`);
      finishResolve(parsed);
    };
    stdout.on('data', onStdout);

    stderr.on('data', (b: Buffer) => {
      process.stderr.write('[daemon stderr] ' + b.toString('utf8'));
    });

    proc.on('error', (err) => {
      finishReject(
        new DaemonSpawnError('spawn-failed', err.message, {
          cause: String(err),
        }),
      );
    });

    proc.on('exit', (code, signal) => {
      console.warn(
        `[daemon-spawner] daemon exited code=${code} signal=${signal}`,
      );
      child = null;
      port = null;
      // If we hadn't resolved yet, surface the early exit.
      finishReject(
        new DaemonSpawnError(
          'early-exit',
          `daemon exited before PORT line (code=${code} signal=${signal})`,
          { code, signal },
        ),
      );
    });
  });

  return readyPromise;
}

/** Synchronous accessor used by the preload bridge. Returns null until the
 *  spawn promise resolves; the renderer is expected to retry / await. */
export function getDaemonPort(): number | null {
  return port;
}

/** Tear down the child on app quit. Idempotent. SIGTERM first; the daemon
 *  is responsible for graceful shutdown. */
export function killDaemon(): void {
  const c = child;
  if (!c) return;
  child = null;
  port = null;
  readyPromise = null;
  try {
    c.kill('SIGTERM');
  } catch {
    /* best-effort */
  }
}

/** Test-only: reset module-level state so unit tests can spawn fresh
 *  daemons across cases without process re-import. Not exported through
 *  any production import path — only `electron/__tests__/*.test.ts` uses
 *  this. Idempotent. */
export function __resetForTests(): void {
  child = null;
  port = null;
  readyPromise = null;
}
