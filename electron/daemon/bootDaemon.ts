// electron/daemon/bootDaemon.ts
//
// v0.3 Task 4 (frag-6-7 §6.1) — Electron-main boot wire for `spawnDaemon()`.
//
// Single Responsibility: SINK. Owns the boot-time decision tree:
//   1. Dev mode (`CCSM_DAEMON_DEV=1`)? → skip entirely. nodemon owns the
//      daemon lifecycle in dev (frag-3.7 §3.7.6.a "Supervisor active? NO").
//   2. Probe the control socket. Already-alive → skip spawn (attach to the
//      existing daemon — re-opening Electron must reuse the surviving
//      daemon process per the v0.3 dogfood metric "daemon survives quit").
//   3. Otherwise spawn the production daemon binary, **detached + unref()**
//      so the OS does NOT tear it down when Electron quits. v0.3 explicitly
//      requires daemon survival across Electron restarts (frag-6-7 §6.1
//      Spawn-or-attach + dogfood metric #1).
//
// Notes:
//   - This is the minimal boot-path wire. Full `daemonSupervisor.start()`
//     (lock-file probe, healthz heartbeat, crash-loop detection, .bak
//     rollback) is Task 7 / a separate PR. Task 4 (this file) just ensures
//     the daemon child exists; the existing connect-probe is enough to
//     honor the double-bind guard during the v0.3 ship.
//   - The connect-probe + control-socket path computation here mirrors
//     `scripts/double-bind-guard.ts` byte-for-byte. We intentionally do NOT
//     import from `scripts/` (which is outside `tsconfig.electron.json`) or
//     from `daemon/src/` (which is a separate workspace bundle) — both
//     stay zero-dep relative to electron-main. A drift-guard test pins
//     this mirror against `daemon/src/sockets/control-socket.ts`.

import { connect, type Socket } from 'node:net';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { posix, win32 } from 'node:path';
import { spawnDaemon } from './supervisor';

// ---------------------------------------------------------------------------
// Pure path resolution (mirror of scripts/double-bind-guard.ts).
// ---------------------------------------------------------------------------

function joinFor(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === 'win32' ? win32.join(...parts) : posix.join(...parts);
}

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

// ---------------------------------------------------------------------------
// Connect-probe (pure decider; never throws).
// ---------------------------------------------------------------------------

export type ProbeOutcome =
  | { kind: 'alive'; socketPath: string }
  | { kind: 'absent'; socketPath: string; reason: string }
  | { kind: 'zombie'; socketPath: string; reason: string };

export interface ProbeOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  connector?: (socketPath: string) => Socket;
}

export function probeControlSocket(opts: ProbeOptions = {}): Promise<ProbeOutcome> {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const timeoutMs = opts.timeoutMs ?? 500;
  const socketPath = resolveControlSocketPath(platform, env);

  return new Promise<ProbeOutcome>((resolve) => {
    const sock = opts.connector ? opts.connector(socketPath) : connect(socketPath);
    let settled = false;
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* ignore */ }
      resolve(outcome);
    };
    const timer = setTimeout(() => {
      finish({ kind: 'zombie', socketPath, reason: `no connect verdict within ${timeoutMs}ms` });
    }, timeoutMs);
    timer.unref?.();
    sock.once('connect', () => { clearTimeout(timer); finish({ kind: 'alive', socketPath }); });
    sock.once('error', (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      finish({ kind: 'absent', socketPath, reason: err.code ?? err.message ?? 'unknown' });
    });
  });
}

// ---------------------------------------------------------------------------
// Production daemon binary resolver.
// ---------------------------------------------------------------------------

/**
 * Production binary path (mirror of frag-11 §11.2). Packaged builds resolve
 * via `process.resourcesPath`; unpackaged Electron runs that are NOT in
 * `CCSM_DAEMON_DEV=1` mode return null (caller skips spawn — there's no
 * sensible binary to run, and dev mode is owned by nodemon anyway).
 */
export function resolveDaemonBinary(opts: {
  isPackaged: boolean;
  resourcesPath: string;
  platform?: NodeJS.Platform;
}): string | null {
  if (!opts.isPackaged) return null;
  const platform = opts.platform ?? process.platform;
  const ext = platform === 'win32' ? '.exe' : '';
  return joinFor(platform, opts.resourcesPath, 'daemon', `ccsm-daemon${ext}`);
}

// ---------------------------------------------------------------------------
// Boot orchestrator (sink).
// ---------------------------------------------------------------------------

export interface BootDaemonDeps {
  /** `app.isPackaged` mirror so this module stays Electron-free for tests. */
  isPackaged: boolean;
  /** `process.resourcesPath` mirror (only read when isPackaged). */
  resourcesPath: string;
  /** Defaults to process.env. */
  env?: NodeJS.ProcessEnv;
  /** Test seam — bypass the connect probe. */
  probe?: typeof probeControlSocket;
  /** Test seam — bypass the actual spawn. */
  spawn?: typeof spawnDaemon;
  /** Test seam — log sink (stderr by default). */
  log?: (line: string) => void;
}

export type BootDaemonOutcome =
  | { kind: 'skipped-dev' }
  | { kind: 'skipped-already-alive'; socketPath: string }
  | { kind: 'skipped-no-binary'; reason: string }
  | { kind: 'spawned'; pid: number | undefined; binary: string }
  | { kind: 'spawn-failed'; binary: string; reason: string };

/**
 * Boot-time wire. Honors:
 *   - dev short-circuit (`CCSM_DAEMON_DEV=1` → no-op; nodemon owns it)
 *   - double-bind guard (alive socket → no second spawn; we attach later)
 *   - daemon-survives-Electron-quit (spawn detached + child.unref())
 *
 * Always resolves; never throws. Failures degrade to a logged outcome so
 * Electron boot continues even if the daemon binary is missing or crashes
 * immediately — the renderer's existing not-connected UX surfaces it.
 */
export async function bootDaemon(deps: BootDaemonDeps): Promise<BootDaemonOutcome> {
  const env = deps.env ?? process.env;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const tag = '[boot-daemon]';

  if (env.CCSM_DAEMON_DEV === '1') {
    log(`${tag} CCSM_DAEMON_DEV=1, nodemon owns daemon lifecycle, skipping spawn`);
    return { kind: 'skipped-dev' };
  }

  const probeFn = deps.probe ?? probeControlSocket;
  const outcome = await probeFn({ env });
  if (outcome.kind === 'alive') {
    log(`${tag} daemon already bound at ${outcome.socketPath}, attaching (no spawn)`);
    return { kind: 'skipped-already-alive', socketPath: outcome.socketPath };
  }
  if (outcome.kind === 'zombie') {
    log(`${tag} WARN: control socket at ${outcome.socketPath} appears wedged (${outcome.reason}); spawning anyway`);
  } else {
    log(`${tag} no daemon at ${outcome.socketPath} (${outcome.reason}), spawning`);
  }

  const binary = resolveDaemonBinary({
    isPackaged: deps.isPackaged,
    resourcesPath: deps.resourcesPath,
  });
  if (!binary) {
    const reason = 'unpackaged Electron without CCSM_DAEMON_DEV=1; no daemon binary available';
    log(`${tag} ${reason} — skipping spawn (use npm run dev for nodemon-managed daemon)`);
    return { kind: 'skipped-no-binary', reason };
  }

  const spawnFn = deps.spawn ?? spawnDaemon;
  try {
    const child = spawnFn({
      binary,
      // Detach + unref so the daemon survives Electron quit. v0.3 dogfood
      // metric #1: re-opening Electron must reuse the existing daemon.
      // `windowsHide: true` prevents a console flash on Windows when the
      // daemon binary is launched from a GUI Electron process.
      spawnOptions: {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      },
    });
    // Detach the child from the parent's reference set so Node won't keep
    // the event loop alive on the child's behalf and (more importantly)
    // won't propagate Electron's exit to the daemon. The OS-level detach
    // still depends on `detached: true` above.
    try { child.unref(); } catch { /* ignore */ }
    log(`${tag} spawned daemon pid=${child.pid ?? '?'} binary=${binary} (detached)`);
    return { kind: 'spawned', pid: child.pid, binary };
  } catch (err) {
    const reason = (err as Error)?.message ?? String(err);
    log(`${tag} ERROR: spawn failed for ${binary}: ${reason}`);
    return { kind: 'spawn-failed', binary, reason };
  }
}
