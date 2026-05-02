// electron/daemonClient/spawnOrAttach.ts
//
// Probe the daemon lockfile; attach if alive, spawn if not (Task #103,
// frag-3.7 §3.7.2 + §3.7.4 lock).
//
// Behavior contract:
//   - Resolve `<dataRoot>/daemon.lock` via the same algorithm as
//     `scripts/wait-daemon.cjs` (kept byte-for-byte identical so the dev
//     gate and the runtime spawn-or-attach probe agree on "ready"). The
//     resolution is duplicated rather than imported because frag-3.7
//     §3.7.2 mandates wait-daemon.cjs be a zero-deps standalone helper
//     that may run before workspace install.
//   - If the lockfile exists → ATTACH: the daemon is already running, no
//     spawn needed. Return `{ kind: 'attached', lockfilePath }`.
//   - If the lockfile is missing AND we are in dev mode (`CCSM_DAEMON_DEV=1`
//     OR caller passed `dev: true`) → DO NOT SPAWN. Dev mode delegates
//     daemon lifecycle to nodemon (frag-3.7 §3.7.2.b: single canonical
//     daemon entry in dev). Return `{ kind: 'dev-no-spawn', lockfilePath }`
//     so the caller can fall back to the auto-reconnect loop. Closes
//     round-2 devx P0-3 (spawnOrAttach side).
//   - If the lockfile is missing AND we are in prod → SPAWN the bundled
//     daemon binary. Return `{ kind: 'spawned', lockfilePath, child, pid }`.
//
// Single Responsibility:
//   - PRODUCER: lockfile-existence probe (synchronous fs.statSync).
//   - DECIDER: dev-vs-prod policy (env-driven).
//   - SINK: `child_process.spawn` of the prod daemon binary; the actual
//     bin path resolution is injected by the caller (`spawnDaemonFn`)
//     so this module stays pure-testable.
//
// What this module DOESN'T own:
//   - Ready-wait after spawn — that's the auto-reconnect loop in
//     `connectClient.ts` (will retry until the daemon binds Listener A).
//   - Lockfile WRITING — the daemon writes it via proper-lockfile at
//     boot (frag-6-7 §6.4). This module only READS.
//   - Path to the bundled daemon binary in prod — caller injects.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  spawn as nativeSpawn,
  type ChildProcess,
  type SpawnOptionsWithoutStdio,
} from 'node:child_process';

const LOCKFILE_NAME = 'daemon.lock' as const;

/**
 * Resolve `<dataRoot>` for the current platform. MUST stay byte-for-byte
 * identical to:
 *   - `daemon/src/sockets/runtime-root.ts` (`resolveDataRoot`)
 *   - `scripts/wait-daemon.cjs`           (`resolveDataRoot`)
 *
 * Drift is caught by `daemon/src/sockets/__tests__/runtime-root.test.ts`
 * (canonical resolver) + the wait-daemon drift guard
 * (`tests/wait-daemon.test.ts`). This module deliberately does NOT add
 * a third drift guard — the existing two cover all permutations and a
 * third copy would just shift the fix-blast-radius.
 */
export function resolveDataRoot(opts?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}): string {
  const platform = opts?.platform ?? process.platform;
  const env = opts?.env ?? process.env;
  const home = opts?.home ?? os.homedir();
  if (platform === 'win32') {
    const local = env['LOCALAPPDATA'];
    if (local && local.length > 0) return path.join(local, 'ccsm');
    return path.join(home, 'AppData', 'Local', 'ccsm');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ccsm');
  }
  const xdgData = env['XDG_DATA_HOME'];
  if (xdgData && xdgData.length > 0) return path.join(xdgData, 'ccsm');
  return path.join(home, '.local', 'share', 'ccsm');
}

/** Resolve the full lockfile path (`<dataRoot>/daemon.lock`). */
export function resolveLockfilePath(opts?: {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
}): string {
  return path.join(resolveDataRoot(opts), LOCKFILE_NAME);
}

export type SpawnOrAttachResult =
  | { readonly kind: 'attached'; readonly lockfilePath: string }
  | { readonly kind: 'dev-no-spawn'; readonly lockfilePath: string }
  | {
      readonly kind: 'spawned';
      readonly lockfilePath: string;
      readonly child: ChildProcess;
      readonly pid: number | undefined;
    };

export interface SpawnOrAttachOptions {
  /** Force dev mode. Defaults to checking `process.env.CCSM_DAEMON_DEV === '1'`.
   *  Tests pass an explicit boolean so they don't have to mutate env vars. */
  readonly dev?: boolean;
  /** Path resolver overrides — see {@link resolveDataRoot}. */
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  /** Test seam: substitute the lockfile-existence check. Defaults to
   *  `fs.statSync` returning truthy iff the path exists. */
  readonly lockfileExists?: (lockPath: string) => boolean;
  /** Callable that spawns the prod daemon binary. The caller is
   *  responsible for resolving the binary path (Electron's
   *  `app.getPath('exe')` + `process.resourcesPath` join). Returning
   *  `null` means "no binary available" — the function then yields a
   *  `dev-no-spawn` verdict so the caller falls back to reconnect loop.
   *
   *  Why injection: this module ships in the Electron main bundle which
   *  is built by tsc (CommonJS). The daemon-binary path lives in
   *  `electron/daemon/launchPaths.ts` (or similar) and importing that
   *  here would create a circular load. Injection keeps this module a
   *  pure leaf. */
  readonly spawnDaemonFn?: () => ChildProcess | null;
}

const DEFAULT_LOCKFILE_EXISTS = (lockPath: string): boolean => {
  try {
    fs.statSync(lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    // Non-ENOENT (EACCES / EPERM / EBUSY) — surface to caller. The
    // bridge will then fall through to spawn (which itself may fail
    // with a clearer error) rather than masking a permissions bug.
    throw err;
  }
};

/**
 * Probe + decide. This is the only export the bridge needs.
 *
 * The function is intentionally synchronous in its decision: the
 * lockfile existence check is a single `statSync` (microseconds) and the
 * spawn call is non-blocking (returns immediately with a ChildProcess
 * handle). The READY signal — the daemon actually binding Listener A —
 * is observed asynchronously by the bridge's Connect transport itself
 * (it'll retry connect until ECONNREFUSED stops).
 */
export function spawnOrAttach(opts: SpawnOrAttachOptions = {}): SpawnOrAttachResult {
  const lockfilePath = resolveLockfilePath(opts);
  const exists = (opts.lockfileExists ?? DEFAULT_LOCKFILE_EXISTS)(lockfilePath);
  if (exists) {
    return { kind: 'attached', lockfilePath };
  }
  const isDev = opts.dev ?? (opts.env ?? process.env)['CCSM_DAEMON_DEV'] === '1';
  if (isDev) {
    // Dev mode skips spawn entirely — nodemon owns the daemon
    // lifecycle. The bridge's auto-reconnect loop will eventually
    // succeed once nodemon brings the daemon up.
    return { kind: 'dev-no-spawn', lockfilePath };
  }
  const spawnFn = opts.spawnDaemonFn;
  if (!spawnFn) {
    // No prod-binary spawner injected → degrade to dev-no-spawn so the
    // reconnect loop runs. This is the safe default when the bridge
    // hasn't yet been wired with the bin-path resolver.
    return { kind: 'dev-no-spawn', lockfilePath };
  }
  const child = spawnFn();
  if (!child) {
    return { kind: 'dev-no-spawn', lockfilePath };
  }
  return { kind: 'spawned', lockfilePath, child, pid: child.pid };
}

/**
 * Helper for the production caller: build a `spawnDaemonFn` from a
 * resolved binary path. Detached + unref'd so the daemon survives
 * Electron crashing. Stderr/stdout piped to the caller's choice (default:
 * inherited from the Electron main process so dev-mode `console.error`
 * lines surface — prod ignores this because pkg-built daemon writes its
 * own pino files).
 */
export function makeSpawnDaemonFn(opts: {
  readonly binaryPath: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdio?: SpawnOptionsWithoutStdio['stdio'];
  readonly spawnFn?: typeof nativeSpawn;
}): () => ChildProcess {
  const spawn = opts.spawnFn ?? nativeSpawn;
  return (): ChildProcess => {
    const child = spawn(opts.binaryPath, opts.args ? Array.from(opts.args) : [], {
      cwd: opts.cwd,
      env: opts.env,
      detached: true,
      stdio: opts.stdio ?? 'ignore',
    });
    // unref so Electron exit doesn't wait on the daemon. The daemon
    // owns its own lifecycle (supervisor + lockfile cleanup).
    if (typeof child.unref === 'function') child.unref();
    return child;
  };
}
