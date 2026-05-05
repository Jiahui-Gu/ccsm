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
//   * spawn ENOENT → reject the ready promise.
//   * exit before PORT line → reject the ready promise.
//   * stdout PORT line malformed → reject the ready promise.

import { spawn, type ChildProcess } from 'child_process';
import * as path from 'path';

let child: ChildProcess | null = null;
let port: number | null = null;
let readyPromise: Promise<number> | null = null;

/** Path to the daemon entrypoint. dev-A owns this file; in dev we run the
 *  same `dist/daemon/index.js` that the prod bundle ships. Override with
 *  `CCSM_DAEMON_ENTRY` for tests / one-off probes. */
function resolveDaemonEntry(): string {
  const override = process.env.CCSM_DAEMON_ENTRY;
  if (override && override.length > 0) return override;
  // __dirname is .../dist/electron, so daemon entry sits at
  // .../dist/daemon/index.js after `tsc -p tsconfig.electron.json`.
  return path.join(__dirname, '..', 'daemon', 'index.js');
}

/** Spawn the daemon if it isn't already running, return the resolved port.
 *  Idempotent — repeat calls return the same promise. */
export function spawnDaemon(): Promise<number> {
  if (readyPromise) return readyPromise;

  const entry = resolveDaemonEntry();
  // Use the same Node runtime that's executing main (Electron's bundled
  // node when dev, Node when packaged headless). `process.execPath` points
  // at the Electron binary in dev — we still want Node semantics for the
  // daemon, so prefer `process.env.npm_node_execpath` when set, else fall
  // back to `node` from PATH. Packaged builds will set CCSM_DAEMON_NODE.
  const nodeBin =
    process.env.CCSM_DAEMON_NODE ||
    process.env.npm_node_execpath ||
    'node';

  const proc = spawn(nodeBin, [entry], {
    cwd: process.cwd(),
    env: {
      ...process.env,
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
      new Error('[daemon-spawner] spawn returned no stdout/stderr pipes'),
    );
  }

  readyPromise = new Promise<number>((resolve, reject) => {
    let resolved = false;
    let stdoutBuf = '';

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
        reject(
          new Error(
            `[daemon-spawner] expected first stdout line "PORT=<n>", got ${JSON.stringify(firstLine)}`,
          ),
        );
        return;
      }
      const parsed = Number(m[1]);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) {
        reject(
          new Error(
            `[daemon-spawner] invalid port from daemon: ${JSON.stringify(firstLine)}`,
          ),
        );
        return;
      }
      port = parsed;
      resolved = true;
      // Swap to a passthrough handler for any further stdout (logs).
      stdout.removeListener('data', onStdout);
      stdout.on('data', (b: Buffer) => {
        process.stderr.write('[daemon stdout] ' + b.toString('utf8'));
      });
      if (rest.length > 0) {
        process.stderr.write('[daemon stdout] ' + rest);
      }
      console.log(`[daemon-spawner] daemon ready on port ${parsed}`);
      resolve(parsed);
    };
    stdout.on('data', onStdout);

    stderr.on('data', (b: Buffer) => {
      process.stderr.write('[daemon stderr] ' + b.toString('utf8'));
    });

    proc.on('error', (err) => {
      if (!resolved) reject(err);
    });

    proc.on('exit', (code, signal) => {
      console.warn(
        `[daemon-spawner] daemon exited code=${code} signal=${signal}`,
      );
      child = null;
      port = null;
      // If we hadn't resolved yet, surface the early exit.
      if (!resolved) {
        reject(
          new Error(
            `[daemon-spawner] daemon exited before PORT line (code=${code} signal=${signal})`,
          ),
        );
      }
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
