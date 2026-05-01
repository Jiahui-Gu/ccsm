// T72 — dev nodemon double-bind guard.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.7-dev-workflow.md §3.7.6.a
//     ("Supervisor restart loop disabled in dev; transport + healthz polling
//     stay"): in `CCSM_DAEMON_DEV=1`, nodemon is the de-facto supervisor.
//     But nodemon double-fires on rapid file saves — if a previous daemon is
//     still bound to the control socket, the new node process trips
//     EADDRINUSE and the dev shell shows a confusing crash. This guard
//     catches that race BEFORE nodemon spawns: probe the control socket
//     first, exit cleanly with "skip" if a daemon is already bound.
//   - docs/superpowers/specs/v0.3-design.md §3.1.1 — control-socket path:
//       POSIX:   `<runtimeRoot>/ccsm-control.sock`
//       Windows: `\\.\pipe\ccsm-control-<userhash>` (sha256 of
//                `username@hostname`, 8-hex truncated)
//
// Probe strategy (connect-only, NOT full daemon.hello HMAC):
//   - Attempt `net.connect(controlSocketPath)` with a short timeout.
//   - SUCCESS → daemon already bound → exit 0, "skip spawn".
//   - ECONNREFUSED / ENOENT (POSIX), `EPIPE` / "connect ENOENT" (Win) →
//     no daemon → caller proceeds with spawn.
//   - Connect returns but no data within timeout → treat as zombie:
//     log warning, still proceed with spawn (nodemon's own error surface
//     will catch any actual bind conflict).
//
//   Full daemon.hello HMAC envelope was considered and rejected: it would
//   require importing the daemon secret + envelope codec into a dev script
//   that must stay zero-dep (mirrors T64 wait-daemon's reasoning). Connect
//   success on the OS-native socket node is sufficient evidence that
//   *something* owns the bind slot; if it's a zombie, the operator restarts
//   nodemon manually after killing it (rare; logged loudly).
//
// Drift guard: the control-socket path computation is a byte-for-byte mirror
// of `daemon/src/sockets/control-socket.ts::defaultControlSocketPath` +
// `daemon/src/sockets/runtime-root.ts::resolveRuntimeRoot`. We do NOT import
// from daemon/ to keep the dev script zero-dep and runnable from a fresh
// clone. A unit test pins both byte-for-byte across the matrix.
//
// Single Responsibility: PURE DECIDER. Inputs: env + platform + a connect
// probe. Output: ProbeResult discriminated union. Caller (dev-watch.ts)
// owns the sink (process.exit / spawn).

import { connect, type Socket } from 'node:net';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { join, posix, win32 } from 'node:path';

export type ProbeOutcome =
  | { kind: 'alive'; socketPath: string }
  | { kind: 'absent'; socketPath: string; reason: string }
  | { kind: 'zombie'; socketPath: string; reason: string };

export interface ProbeOptions {
  /** Override for tests; defaults to current process platform. */
  platform?: NodeJS.Platform;
  /** Override for tests; defaults to current process env. */
  env?: NodeJS.ProcessEnv;
  /** Connect timeout, ms. Defaults to 500 (matches brief). */
  timeoutMs?: number;
  /** Test seam: a custom connector returning a Socket-like object. */
  connector?: (socketPath: string) => Socket;
}

/** Platform-aware path joiner so a Windows-host test forcing
 *  `platform: 'linux'` still yields a POSIX-shaped path (mirrors daemon
 *  control-socket.ts: it uses `posix.join` for the POSIX branch). */
function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

/** Mirror of daemon/src/sockets/runtime-root.ts (drift-guarded). */
export function resolveDataRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local && local.length > 0) return win32.join(local, 'ccsm');
    return win32.join(homedir(), 'AppData', 'Local', 'ccsm');
  }
  if (platform === 'darwin') {
    return joinFor(platform, homedir(), 'Library', 'Application Support', 'ccsm');
  }
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) return joinFor(platform, xdgData, 'ccsm');
  return joinFor(platform, homedir(), '.local', 'share', 'ccsm');
}

/** Mirror of daemon/src/sockets/runtime-root.ts (drift-guarded). */
export function resolveRuntimeRoot(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'linux') {
    const xdgRuntime = env.XDG_RUNTIME_DIR;
    if (xdgRuntime && xdgRuntime.length > 0) return joinFor(platform, xdgRuntime, 'ccsm');
  }
  return joinFor(platform, resolveDataRoot(platform, env), 'run');
}

/** Mirror of daemon/src/sockets/control-socket.ts::defaultControlSocketPath. */
export function resolveControlSocketPath(
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
): string {
  if (platform === 'win32') {
    const ui = userInfo();
    const tag = `${ui.username}@${hostname()}`;
    const userhash = createHash('sha256').update(tag).digest('hex').slice(0, 8);
    return `\\\\.\\pipe\\ccsm-control-${userhash}`;
  }
  return posix.join(resolveRuntimeRoot(platform, env), 'ccsm-control.sock');
}

/**
 * Probe the control socket. Resolves on outcome; never rejects (all errors
 * map to `absent` or `zombie`).
 */
export function probeControlSocket(opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 500;
  const socketPath = resolveControlSocketPath(platform, env);

  return new Promise<ProbeOutcome>((resolve) => {
    const sock = opts.connector
      ? opts.connector(socketPath)
      : connect(socketPath);

    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        sock.destroy();
      } catch {
        /* ignore */
      }
      resolve(outcome);
    };

    const timer = setTimeout(() => {
      finish({
        kind: 'zombie',
        socketPath,
        reason: `no connect verdict within ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    sock.once('connect', () => {
      clearTimeout(timer);
      finish({ kind: 'alive', socketPath });
    });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({
        kind: 'absent',
        socketPath,
        reason: err.code ?? err.message ?? 'unknown',
      });
    });
  });
}

/**
 * Top-level guard: probe and decide. Returns `true` if the caller should
 * proceed to spawn nodemon, `false` if it should exit cleanly.
 *
 * Side effect: prints a single tagged log line to stderr describing the
 * decision. Does NOT call process.exit — the caller owns that sink.
 */
export async function shouldSpawnDaemon(
  opts: ProbeOptions = {},
): Promise<boolean> {
  const outcome = await probeControlSocket(opts);
  const tag = '[daemon-guard]';
  switch (outcome.kind) {
    case 'alive':
      process.stderr.write(
        `${tag} daemon already bound at ${outcome.socketPath}, skipping spawn\n`,
      );
      return false;
    case 'absent':
      process.stderr.write(
        `${tag} no daemon at ${outcome.socketPath} (${outcome.reason}), spawning\n`,
      );
      return true;
    case 'zombie':
      process.stderr.write(
        `${tag} WARN: control socket at ${outcome.socketPath} appears wedged (${outcome.reason}); spawning anyway, nodemon will surface any bind conflict\n`,
      );
      return true;
  }
}
