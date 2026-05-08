// T12 (#655) — daemon lifecycle: SIGINT shutdown + idle-stays-alive smoke.
//
// What we are proving:
//
//   * SIGINT path (POSIX only): the daemon installs a SIGINT handler that
//     calls server.close() and then process.exit(0) within SHUTDOWN_TIMEOUT_MS
//     (2s in src/index.mts). We assert the child exits inside 4s after we
//     send the signal — generous bound to avoid CI flake while still catching
//     a regression where the handler leaks the event loop.
//
//   * Idle-stays-alive (cross-platform): the daemon should not crash or
//     self-exit when no client is connected. We boot it, wait long enough to
//     catch a "timer leak that fires once" or "unhandled rejection that
//     bubbles out of nextTick" (5s on default CI; bumpable via env), then
//     assert (a) the process is still running, and (b) no stderr has been
//     emitted. This is a cheap proxy for "no obvious idle leak"; a true
//     RSS check would need an internal /debug/rss endpoint, which we
//     deliberately do NOT add to keep the production attack surface
//     minimal — see README/PR for the rationale.
//
// Windows note: process.kill('SIGINT') on win32 is implemented as a hard
// TerminateProcess (Node maps the signal but the OS does not deliver it as
// a graceful interrupt). The graceful-shutdown assertion would therefore
// just measure how fast TerminateProcess returns, which is meaningless.
// We skip the SIGINT case on win32 with an explicit comment so a future
// reader knows it is a platform limitation, not an oversight.

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PKG_DIR = resolve(__dirname, '..');
const DIST_ENTRY = resolve(DAEMON_PKG_DIR, 'dist', 'index.mjs');
const SRC_ENTRY = resolve(DAEMON_PKG_DIR, 'src', 'index.mts');

const READY_RE = /ccsm ready: (http:\/\/127\.0\.0\.1:\d+\/\?token=([\w-]+))/;
const READY_TIMEOUT_MS = 10_000;
const SIGINT_GRACE_MS = 4_000;
// Idle wait must be > the daemon's internal SHUTDOWN_TIMEOUT_MS (2s) so we
// catch a "self-shutdown after N seconds" regression. 5s is the smallest
// bound that comfortably covers that without slowing the suite materially.
const IDLE_WAIT_MS = 5_000;
const TUNNEL_LOG_WAIT_MS = 1_500;

interface BootResult {
  proc: ChildProcess;
  url: string;
  token: string;
  /** Live-updated reference; read after the assertion window. */
  stderrRef: { value: string };
}

function pickEntry(): { cmd: string; args: string[] } {
  if (existsSync(DIST_ENTRY)) {
    return { cmd: process.execPath, args: [DIST_ENTRY] };
  }
  if (existsSync(SRC_ENTRY)) {
    return { cmd: process.execPath, args: ['--import', 'tsx', SRC_ENTRY] };
  }
  throw new Error(
    `daemon entry not found. Looked for:\n  ${DIST_ENTRY}\n  ${SRC_ENTRY}\n` +
      `Run \`pnpm -F @ccsm/daemon build\` before this test.`,
  );
}

async function bootDaemon(extraEnv: Record<string, string> = {}): Promise<BootResult> {
  const { cmd, args } = pickEntry();
  // Force port 0? The daemon parses PORT but does not accept "0" -> ephemeral;
  // it has its own EADDRINUSE retry from DEFAULT_PORT. Picking a random port
  // far from 17832 keeps parallel test runs from clashing.
  const port = 19000 + Math.floor(Math.random() * 1000);
  // Disable the cloud tunnel by default — most lifecycle assertions run
  // offline / on CI without network and would otherwise see ws errors on
  // stderr. Tunnel-specific cases pass extraEnv to override.
  const env: Record<string, string> = {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(port),
    CCSM_TUNNEL_DISABLE: '1',
    ...extraEnv,
  };
  const proc = spawn(cmd, args, {
    cwd: DAEMON_PKG_DIR,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let stdoutBuf = '';
  const stderrRef = { value: '' };
  proc.stdout?.on('data', (c: Buffer) => {
    stdoutBuf += c.toString('utf8');
  });
  proc.stderr?.on('data', (c: Buffer) => {
    stderrRef.value += c.toString('utf8');
  });

  const ready = await new Promise<{ url: string; token: string } | Error>(
    (resolveReady) => {
      const timer = setTimeout(() => {
        resolveReady(
          new Error(
            `daemon did not print ready line within ${READY_TIMEOUT_MS}ms.\n` +
              `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrRef.value}`,
          ),
        );
      }, READY_TIMEOUT_MS);
      const tryMatch = (): void => {
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
              `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrRef.value}`,
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
  return { proc, url: ready.url, token: ready.token, stderrRef };
}

async function killHard(proc: ChildProcess): Promise<void> {
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));
  try {
    proc.kill('SIGKILL');
  } catch {
    // ignore
  }
  await Promise.race([exited, new Promise<void>((r) => setTimeout(r, 2_000))]);
}

describe('daemon lifecycle (T12)', () => {
  it.skipIf(process.platform === 'win32')(
    'exits within 4s of SIGINT (POSIX)',
    async () => {
      const boot = await bootDaemon();
      try {
        const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
          (r) => {
            boot.proc.once('exit', (code, signal) => r({ code, signal }));
          },
        );
        const t0 = Date.now();
        boot.proc.kill('SIGINT');
        const result = await Promise.race([
          exited,
          new Promise<'timeout'>((r) =>
            setTimeout(() => r('timeout'), SIGINT_GRACE_MS),
          ),
        ]);
        const elapsed = Date.now() - t0;
        if (result === 'timeout') {
          throw new Error(
            `daemon did not exit within ${SIGINT_GRACE_MS}ms after SIGINT ` +
              `(elapsed=${elapsed}ms). stderr was:\n${boot.stderrRef.value}`,
          );
        }
        // Graceful path: exit code 0. The daemon's signal handler logs to
        // stderr ("[ccsm] received SIGINT, shutting down"); we do NOT assert
        // stderr is empty here — the handler intentionally writes a notice.
        expect(result.code).toBe(0);
      } finally {
        await killHard(boot.proc);
      }
    },
    20_000,
  );

  it(
    `stays alive and quiet across a ${IDLE_WAIT_MS}ms idle window`,
    async () => {
      const boot = await bootDaemon();
      try {
        const exited = new Promise<'exited'>((r) => {
          boot.proc.once('exit', () => r('exited'));
        });
        const result = await Promise.race([
          exited,
          new Promise<'still-alive'>((r) =>
            setTimeout(() => r('still-alive'), IDLE_WAIT_MS),
          ),
        ]);
        expect(result).toBe('still-alive');
        // No unexpected stderr should have been emitted while idle. The
        // tunnel subsystem (Task #777) prints one informational line on
        // boot ("[ccsm] tunnel: disabled ..." in this test) which we
        // explicitly filter out — it's expected, not a regression signal.
        const idleStderr = boot.stderrRef.value
          .split('\n')
          .filter((l) => l.length > 0 && !l.startsWith('[ccsm] tunnel:'))
          .join('\n');
        expect(idleStderr, `unexpected stderr during idle: ${boot.stderrRef.value}`).toBe('');
        // Process still reports alive.
        expect(boot.proc.exitCode).toBeNull();
        expect(boot.proc.signalCode).toBeNull();
      } finally {
        await killHard(boot.proc);
      }
    },
    IDLE_WAIT_MS + 15_000,
  );

  // Task #777 (S3-T4): dual-listen — loopback + tunnel run in parallel,
  // tunnel failure must never abort the loopback path.
  it(
    'CCSM_TUNNEL_DISABLE=1 boots loopback only, no tunnel connect attempt',
    async () => {
      const boot = await bootDaemon({ CCSM_TUNNEL_DISABLE: '1' });
      try {
        // Give the daemon a moment to print any startup diagnostics.
        await new Promise<void>((r) => setTimeout(r, TUNNEL_LOG_WAIT_MS));
        // Loopback is up: ready line already matched in bootDaemon.
        // Tunnel must NOT have attempted to connect.
        expect(boot.stderrRef.value).not.toMatch(/tunnel: connecting/);
        expect(boot.stderrRef.value).toMatch(/tunnel: disabled \(CCSM_TUNNEL_DISABLE\)/);
        // Loopback HTTP still serves: /token responds 200 (no auth required).
        const res = await fetch(`${boot.url.replace(/\/\?token=.*$/, '')}/token`);
        expect(res.status).toBe(200);
      } finally {
        await killHard(boot.proc);
      }
    },
    20_000,
  );

  it(
    'tunnel default-on: unreachable URL still leaves loopback serving',
    async () => {
      // Pick a deliberately unreachable URL (port 1, refused everywhere).
      // Tunnel will log "connecting", then ws/connect errors, then schedule
      // a backoff reconnect — but the loopback HTTP server must remain up.
      const boot = await bootDaemon({
        CCSM_TUNNEL_DISABLE: '',
        CCSM_TUNNEL_URL: 'ws://127.0.0.1:1/tunnel/default',
      });
      try {
        await new Promise<void>((r) => setTimeout(r, TUNNEL_LOG_WAIT_MS));
        expect(boot.stderrRef.value).toMatch(/tunnel: connecting ws:\/\/127\.0\.0\.1:1/);
        // Loopback HTTP must still respond even though tunnel is down.
        const res = await fetch(`${boot.url.replace(/\/\?token=.*$/, '')}/token`);
        expect(res.status).toBe(200);
        expect(boot.proc.exitCode).toBeNull();
      } finally {
        await killHard(boot.proc);
      }
    },
    20_000,
  );
});
