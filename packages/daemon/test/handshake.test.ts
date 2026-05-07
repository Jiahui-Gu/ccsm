// Task #683 (wave-2 T1) — daemon handshake protocol.
//
// What we are proving:
//
//   * `--handshake-stdout` mode: the daemon's first stdout line is a strict
//     JSON object `{"ready":true,"port":<n>,"token":"<32-hex>"}`, AND no
//     further bytes appear on stdout after that line for the lifetime of the
//     process. (All diagnostics must go to stderr; this is the contract the
//     Tauri Rust shell relies on in T8.)
//
//   * Legacy mode (no flag): stdout still prints the wave-1
//     `ccsm ready: http://127.0.0.1:<port>/?token=<token>` line on a fixed
//     port (DEFAULT_PORT = 17832 unless PORT env overrides). This is a
//     regression guard for the e2e harness which greps that exact shape.
//
// We re-implement a minimal `bootDaemon` here instead of importing from
// lifecycle.test.ts to keep the test files independent (vitest may run them
// in parallel; sharing a helper would otherwise drag in lifecycle's idle
// timer assertions).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DAEMON_PKG_DIR = resolve(__dirname, '..');
const DIST_ENTRY = resolve(DAEMON_PKG_DIR, 'dist', 'index.mjs');
const SRC_ENTRY = resolve(DAEMON_PKG_DIR, 'src', 'index.mts');

const READY_TIMEOUT_MS = 10_000;
const QUIET_OBSERVATION_MS = 750;

const HANDSHAKE_TOKEN_RE = /^[0-9a-f]{32}$/;
const LEGACY_READY_RE =
  /^ccsm ready: http:\/\/127\.0\.0\.1:(\d+)\/\?token=([\w-]+)\n$/;

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

interface SpawnOpts {
  flags?: string[];
  env?: Record<string, string>;
}

interface BootedProc {
  proc: ChildProcess;
  /** Live-updated by data listeners. */
  stdoutRef: { value: string };
  stderrRef: { value: string };
}

function spawnDaemon(opts: SpawnOpts = {}): BootedProc {
  const entry = pickEntry();
  // We deliberately do NOT pin PORT for the handshake case (it's port 0); for
  // the legacy case the test picks a random non-default port to avoid
  // colliding with a developer's locally-running daemon.
  const proc = spawn(entry.cmd, [...entry.args, ...(opts.flags ?? [])], {
    cwd: DAEMON_PKG_DIR,
    env: { ...process.env, NODE_ENV: 'test', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutRef = { value: '' };
  const stderrRef = { value: '' };
  proc.stdout?.on('data', (c: Buffer) => {
    stdoutRef.value += c.toString('utf8');
  });
  proc.stderr?.on('data', (c: Buffer) => {
    stderrRef.value += c.toString('utf8');
  });
  return { proc, stdoutRef, stderrRef };
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

async function waitForFirstStdoutLine(
  booted: BootedProc,
  timeoutMs: number,
): Promise<string> {
  return await new Promise<string>((resolveLine, rejectLine) => {
    const timer = setTimeout(() => {
      rejectLine(
        new Error(
          `no stdout line within ${timeoutMs}ms.\n` +
            `--- stdout (${booted.stdoutRef.value.length}b) ---\n${booted.stdoutRef.value}\n` +
            `--- stderr ---\n${booted.stderrRef.value}`,
        ),
      );
    }, timeoutMs);
    const tryMatch = (): void => {
      const nl = booted.stdoutRef.value.indexOf('\n');
      if (nl >= 0) {
        clearTimeout(timer);
        // Include the trailing \n so callers can sanity-check the line shape.
        resolveLine(booted.stdoutRef.value.slice(0, nl + 1));
      }
    };
    booted.proc.stdout?.on('data', tryMatch);
    booted.proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      rejectLine(
        new Error(
          `daemon exited before stdout (code=${code} signal=${signal}).\n` +
            `--- stderr ---\n${booted.stderrRef.value}`,
        ),
      );
    });
    tryMatch();
  });
}

describe('daemon handshake (Task #683)', () => {
  const cleanups: ChildProcess[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const p = cleanups.pop();
      if (p) await killHard(p);
    }
  });

  it('emits a single JSON line on stdout under --handshake-stdout', async () => {
    const booted = spawnDaemon({
      flags: ['--handshake-stdout'],
      // Force an isolated db so the test doesn't poke the user's real one.
      env: { CCSM_DB_PATH: ':memory:' },
    });
    cleanups.push(booted.proc);

    const firstLine = await waitForFirstStdoutLine(booted, READY_TIMEOUT_MS);

    // The line itself must be exactly a JSON object + newline. No prefix, no
    // suffix, no banner.
    expect(firstLine.endsWith('\n')).toBe(true);
    const parsed = JSON.parse(firstLine.trim()) as {
      ready: unknown;
      port: unknown;
      token: unknown;
    };
    expect(parsed.ready).toBe(true);
    expect(typeof parsed.port).toBe('number');
    expect(parsed.port as number).toBeGreaterThan(0);
    // Port 0 means OS-assigned; the actual bound port must be a real one.
    expect(parsed.port as number).toBeLessThanOrEqual(65535);
    expect(parsed.port).not.toBe(17832); // ephemeral, not the legacy default
    expect(typeof parsed.token).toBe('string');
    expect(parsed.token as string).toMatch(HANDSHAKE_TOKEN_RE);

    // Now observe a quiet window — no further stdout bytes are allowed. This
    // is the "stdout reserved for handshake" half of the contract.
    const before = booted.stdoutRef.value.length;
    await new Promise((r) => setTimeout(r, QUIET_OBSERVATION_MS));
    const after = booted.stdoutRef.value.length;
    expect(
      after,
      `unexpected stdout after handshake (delta=${after - before}b): ` +
        JSON.stringify(booted.stdoutRef.value.slice(before)),
    ).toBe(before);
  }, 20_000);

  it('keeps legacy `ccsm ready:` line + fixed port without the flag', async () => {
    // Pick a random high port so we don't fight a local dev daemon on 17832.
    const port = 19000 + Math.floor(Math.random() * 1000);
    const booted = spawnDaemon({
      env: { PORT: String(port), CCSM_DB_PATH: ':memory:' },
    });
    cleanups.push(booted.proc);

    const firstLine = await waitForFirstStdoutLine(booted, READY_TIMEOUT_MS);
    const m = firstLine.match(LEGACY_READY_RE);
    expect(m, `legacy ready line did not match. got: ${JSON.stringify(firstLine)}`).not.toBeNull();
    // The bound port must be either the requested one or a near-by port from
    // the EADDRINUSE retry window — we just assert it's a real number, the
    // specific value depends on the host's free ports.
    const boundPort = Number.parseInt(m![1] as string, 10);
    expect(boundPort).toBeGreaterThanOrEqual(port);
    expect(boundPort).toBeLessThan(port + 21);
    // Legacy token is base64url 32-byte (~43 chars), definitely NOT 32-hex.
    const token = m![2] as string;
    expect(token.length).toBeGreaterThan(32);
  }, 20_000);
});
