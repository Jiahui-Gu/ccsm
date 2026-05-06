// frontend-strictmode.spec.ts — Task #658 P1-3 dev verification.
//
// WHY THIS EXISTS:
//   The bug being verified (StrictMode double-mount blanking out MainPane)
//   only reproduces under Vite's *dev* server, because production builds
//   strip <StrictMode>. The existing T0.5 daemon fixture serves the *built*
//   frontend from `packages/frontend/dist`, which would mask the regression.
//
//   So this spec spawns:
//     1. A minimal mock HTTP server on 127.0.0.1:17832 that answers the one
//        endpoint the frontend hits at boot — POST /api/sessions — and stubs
//        a 404 for /ws upgrades. We do NOT need a real PTY; the bug being
//        verified is purely a renderer-side StrictMode invariant. Stubbing
//        the daemon also avoids depending on an unrelated tech-debt where
//        packages/shared/dist emits extension-less ESM imports that Node 22
//        strict mode cannot resolve (out-of-scope for #658 / P1-3).
//     2. `pnpm -F @ccsm/frontend dev` — Vite dev server on :5173, which
//        proxies /api and /ws to 127.0.0.1:17832 per
//        packages/frontend/vite.config.ts.
//
//   Then it navigates to http://127.0.0.1:5173/?token=<token>, waits for
//   the xterm DOM to appear, and snaps a PNG + TXT for manager review.
//
// SCOPE:
//   This is a *temporary dev-mode verification*. T7 owns the long-term
//   product e2e (which runs against the daemon's static build). Reviewer
//   may keep, fold into T7, or delete this spec — see PR description.

import { test, expect } from '@playwright/test';
import { snap } from '../fixtures/screenshot.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { statSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const VITE_PORT = 5173;
const DAEMON_PORT = 17832;
const VITE_READY_TIMEOUT_MS = 30_000;
// Strip ANSI escapes before regex match — vite dev keeps colours even with
// FORCE_COLOR=0 in some shells (Windows pnpm wrapper passes a TTY through).
// eslint-disable-next-line no-control-regex -- ESC byte for ANSI matcher
const ANSI_RE = /\[[0-9;]*[A-Za-z]/g;
const VITE_READY_RE =
  /Local:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

// ---- mock daemon ----
//
// Minimal stand-in for the parts of the daemon the *renderer* hits during
// boot. Listens on 127.0.0.1:DAEMON_PORT so the vite dev proxy can forward
// /api and /ws as usual, then:
//   - POST /api/sessions → 200 { sid: <uuid> }
//   - any /ws upgrade   → close immediately (frontend treats this as a
//                          disconnect; the disconnect notice is harmless and
//                          irrelevant to the bug under test)

interface MockDaemon {
  server: Server;
  token: string;
}

async function startMockDaemon(): Promise<MockDaemon> {
  const token = randomUUID();
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/sessions') {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ sid: randomUUID() }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  // Reject ws upgrades — the renderer treats this as a disconnect, which
  // does not block xterm from mounting (the regression we are checking).
  server.on('upgrade', (_req, socket) => {
    socket.destroy();
  });
  await new Promise<void>((r) =>
    server.listen(DAEMON_PORT, '127.0.0.1', () => r()),
  );
  return { server, token };
}

async function stopMockDaemon(daemon: MockDaemon): Promise<void> {
  await new Promise<void>((r) => daemon.server.close(() => r()));
}

// ---- vite dev server ----

interface ViteHandle {
  proc: ChildProcess;
  url: string;
}

async function startVite(): Promise<ViteHandle> {
  // Invoke vite directly via `pnpm exec` so the CLI flags reach vite intact.
  // `pnpm -F @ccsm/frontend dev -- ...` interposes `--` which vite-cli treats
  // as positional and silently ignores subsequent flags (notably --host),
  // which then defaults to ::1 only — making 127.0.0.1 navigation refuse.
  const proc = spawn(
    'pnpm',
    [
      '-F',
      '@ccsm/frontend',
      'exec',
      'vite',
      '--port',
      String(VITE_PORT),
      '--strictPort',
      '--host',
      '127.0.0.1',
    ],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
    },
  );

  let stdoutBuf = '';
  let stderrBuf = '';
  proc.stdout?.on('data', (chunk: Buffer) => {
    stdoutBuf += chunk.toString('utf8');
  });
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderrBuf += chunk.toString('utf8');
  });

  const ready = await new Promise<string | Error>((resolveReady) => {
    const timer = setTimeout(() => {
      resolveReady(
        new Error(
          `vite dev did not announce ready within ${VITE_READY_TIMEOUT_MS}ms.\n` +
            `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
        ),
      );
    }, VITE_READY_TIMEOUT_MS);

    const tryMatch = (): void => {
      const clean = stdoutBuf.replace(ANSI_RE, '');
      const m = clean.match(VITE_READY_RE);
      if (m) {
        clearTimeout(timer);
        resolveReady(`http://127.0.0.1:${m[1]}`);
      }
    };

    proc.stdout?.on('data', tryMatch);
    proc.on('exit', (code, signal) => {
      clearTimeout(timer);
      resolveReady(
        new Error(
          `vite dev exited before ready (code=${code} signal=${signal}).\n` +
            `--- stdout ---\n${stdoutBuf}\n--- stderr ---\n${stderrBuf}`,
        ),
      );
    });

    tryMatch();
  });

  if (ready instanceof Error) {
    proc.kill('SIGKILL');
    throw ready;
  }
  return { proc, url: ready };
}

async function stopVite(handle: ViteHandle): Promise<void> {
  const { proc } = handle;
  if (proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((r) => proc.once('exit', () => r()));

  // On Windows we spawned via shell:true, so `proc` is cmd.exe wrapping pnpm
  // wrapping node. SIGTERM only kills cmd.exe and leaves the actual vite
  // process orphaned, holding the port for the next test run. Use taskkill
  // /T (tree) to wipe the whole subtree. POSIX falls back to SIGTERM.
  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else {
    proc.kill('SIGTERM');
  }

  await Promise.race([
    exited,
    new Promise<void>((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

test('dev-mode StrictMode — xterm renders into MainPane (no blank pane)', async ({
  page,
}, testInfo) => {
  test.setTimeout(60_000);

  const daemon = await startMockDaemon();
  const vite = await startVite();
  try {
    const url = `${vite.url}/?token=${encodeURIComponent(daemon.token)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Allow StrictMode mount → cleanup → re-mount + xterm.open() to settle.
    // The bug we are guarding against would leave .xterm-screen *missing*
    // because the second mount short-circuited Terminal creation.
    const xtermScreen = page.locator('.xterm-screen');
    await xtermScreen.waitFor({ state: 'attached', timeout: 10_000 });

    const xtermRoot = page.locator('.xterm');
    await expect(xtermRoot).toHaveCount(1, { timeout: 5_000 });

    // Sanity: xterm must be inside the data-testid wrapper (i.e. mounted by
    // *our* component, not some stray ancestor element).
    const termHost = page.locator('[data-testid="main-terminal"] .xterm');
    await expect(termHost).toHaveCount(1);

    const { pngPath, txtPath } = await snap(
      page,
      testInfo,
      'strictmode-mainpane',
    );

    // Manager-readable acceptance: PNG non-empty and TXT references an xterm
    // testid + lacks any pageerror entries (which would mean the StrictMode
    // remount threw).
    const pngStat = statSync(pngPath);
    expect(pngStat.size).toBeGreaterThan(1_000);

    const txt = readFileSync(txtPath, 'utf8');
    expect(txt).toContain('main-terminal');
    expect(txt).not.toContain('[pageerror]');

    // Surface the path so manager can multimodal-Read the PNG.
    // eslint-disable-next-line no-console -- intentional manager-facing log
    console.log(`[strictmode-spec] PNG: ${pngPath}`);
    // eslint-disable-next-line no-console
    console.log(`[strictmode-spec] TXT: ${txtPath}`);
  } finally {
    await stopVite(vite);
    await stopMockDaemon(daemon);
  }
});
