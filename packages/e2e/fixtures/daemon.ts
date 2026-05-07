// Daemon fixture for ccsm e2e (Task #664).
//
// Spawns the daemon as a child process per worker, parses the
// `ccsm ready: <url>` line off stdout, and exposes `daemonUrl` + `token`
// as Playwright test fixtures. Tears the daemon down via SIGINT (with a
// SIGKILL fallback) on worker shutdown.
//
// NOTE — concurrency boundary (Task #664 spec):
// We never import or modify code under packages/daemon/**. We only spawn its
// built artifact (`packages/daemon/dist/index.mjs`) or, if T3 is not yet
// merged, fall back to running its source via `tsx`. Smoke tests in this
// task do not depend on the daemon at all (see tests/smoke.spec.ts), so the
// fixture is opt-in: only tests that destructure `daemonUrl` / `token` will
// trigger the spawn.

import { test as base, type TestInfo } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PKG_DIR = resolve(__dirname, '..', '..', 'daemon');
const DAEMON_DIST_ENTRY = resolve(DAEMON_PKG_DIR, 'dist', 'index.mjs');
const DAEMON_SRC_ENTRY = resolve(DAEMON_PKG_DIR, 'src', 'index.mts');

const READY_RE = /ccsm ready: (http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+))/;
const READY_TIMEOUT_MS = 10_000;
const SHUTDOWN_GRACE_MS = 3_000;

export interface DaemonHandle {
  url: string;
  token: string;
  proc: ChildProcess;
}

export interface StartDaemonOptions {
  /**
   * Extra env vars merged on top of `process.env` for the spawned daemon.
   *
   * Task #753 (S2 spoof-origin e2e): used to opt the daemon into the
   * `CCSM_ALLOW_PAGES_PREVIEWS=1` flag so the e2e suite can verify the
   * env-gated `*.cc-sm.pages.dev` allow-list at the HTTP layer, against a
   * second independently-spawned daemon process (must NOT mutate the
   * shared worker daemon's env mid-flight).
   */
  extraEnv?: Record<string, string>;
}

export async function startDaemon(opts: StartDaemonOptions = {}): Promise<DaemonHandle> {
  const useDist = existsSync(DAEMON_DIST_ENTRY);
  const useSrc = !useDist && existsSync(DAEMON_SRC_ENTRY);

  if (!useDist && !useSrc) {
    throw new Error(
      `daemon entry not found. Looked for:\n  ${DAEMON_DIST_ENTRY}\n  ${DAEMON_SRC_ENTRY}\n` +
        `Run \`pnpm -F @ccsm/daemon build\` (or merge T3) before running e2e tests that need the daemon.`,
    );
  }

  const cmd = process.execPath;
  const args = useDist
    ? [DAEMON_DIST_ENTRY]
    : ['--import', 'tsx', DAEMON_SRC_ENTRY];

  const proc = spawn(cmd, args, {
    cwd: DAEMON_PKG_DIR,
    env: { ...process.env, NODE_ENV: 'test', ...(opts.extraEnv ?? {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const ready = await new Promise<{ url: string; token: string } | Error>(
    (resolveReady) => {
      const timer = setTimeout(() => {
        resolveReady(
          new Error(
            `daemon did not print ready line within ${READY_TIMEOUT_MS}ms.\n` +
              `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
          ),
        );
      }, READY_TIMEOUT_MS);

      const tryMatch = () => {
        const m = stdoutBuf.match(READY_RE);
        if (m) {
          clearTimeout(timer);
          resolveReady({ url: m[1]!, token: m[2]! });
        }
      };

      proc.stdout?.on('data', tryMatch);
      proc.on('exit', (code, signal) => {
        clearTimeout(timer);
        resolveReady(
          new Error(
            `daemon exited before ready (code=${code} signal=${signal}).\n` +
              `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
          ),
        );
      });

      tryMatch();
    },
  );

  if (ready instanceof Error) {
    proc.kill('SIGKILL');
    throw ready;
  }

  return { url: ready.url, token: ready.token, proc };
}

export async function stopDaemon(handle: DaemonHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode !== null || proc.signalCode !== null) return;

  const exited = new Promise<void>((resolveExit) => {
    proc.once('exit', () => resolveExit());
  });

  // Windows ignores POSIX signals for non-console children; Node maps
  // SIGINT/SIGTERM to TerminateProcess on win32 anyway.
  proc.kill('SIGINT');

  const timed = await Promise.race([
    exited.then(() => 'exited' as const),
    new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), SHUTDOWN_GRACE_MS)),
  ]);

  if (timed === 'timeout') {
    proc.kill('SIGKILL');
    await exited;
  }
}

export interface DaemonFixtures {
  daemonUrl: string;
  token: string;
}

// Worker-scoped daemon (one daemon process per Playwright worker), plus
// per-test convenience fixtures `daemonUrl` / `token` that read from it.
export const test = base.extend<DaemonFixtures, { _daemon: DaemonHandle }>({
  _daemon: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires destructured deps even when empty.
    async ({}, use) => {
      const handle = await startDaemon();
      try {
        await use(handle);
      } finally {
        await stopDaemon(handle);
      }
    },
    { scope: 'worker' },
  ],

  daemonUrl: async ({ _daemon }, use) => {
    await use(_daemon.url);
  },

  token: async ({ _daemon }, use) => {
    await use(_daemon.token);
  },
});

export { expect } from '@playwright/test';
export type { TestInfo };
