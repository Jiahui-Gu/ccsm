// groups-sidebar.spec.ts — Task #656 / T9 dev verification.
//
// WHAT THIS PROVES:
//   The GROUPS sidebar (DESIGN.md §7) renders one row per session under a
//   single hard-coded "default" group, supports + New Session to append
//   rows, click-to-setActive (with the active row marked `*`), and X-button
//   close that prunes the row + rotates active to a sibling.
//
// WHY DEV-MODE (vite + mock daemon):
//   The xterm/ws boot path is irrelevant to the sidebar contract under
//   test, and the real `claude` CLI is not available on CI. We mock just
//   the two endpoints the sidebar hits — POST /api/sessions and
//   DELETE /api/sessions/:sid — and reject ws upgrades (the disconnect
//   notice doesn't block anything in the sidebar). MainPane's bootstrap
//   path will create the *first* session on its own; subsequent sessions
//   are driven by the user clicking + New Session, which is what we test.
//
// SCOPE:
//   Mirrors the dispatch spec's e2e checklist: + New Session twice, click
//   the first row, hover-and-X the active row, snap PNG + TXT for manager
//   review.

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
// eslint-disable-next-line no-control-regex -- ESC byte for ANSI matcher
const ANSI_RE = /\x1b?\[[0-9;]*[A-Za-z]/g;
// Some Windows pnpm wrappers leak the bare ESC byte AFTER stripping the
// `[..m` segment. Drop any remaining ESCs before applying VITE_READY_RE.
// eslint-disable-next-line no-control-regex
const ESC_RE = /\x1b/g;
const VITE_READY_RE =
  /Local:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

interface MockDaemon {
  server: Server;
  token: string;
  /** sids the mock has handed out — useful for assertions if needed. */
  createdSids: string[];
  /** sids the mock has received DELETE for. */
  deletedSids: string[];
}

async function startMockDaemon(): Promise<MockDaemon> {
  const token = randomUUID();
  const createdSids: string[] = [];
  const deletedSids: string[] = [];
  const server = createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'POST' && url === '/api/sessions') {
      // Drain the body so the socket doesn't stall on Windows.
      req.on('data', () => {});
      req.on('end', () => {
        const sid = randomUUID();
        createdSids.push(sid);
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ sid, createdAt: Date.now() }));
      });
      return;
    }
    if (req.method === 'DELETE' && url.startsWith('/api/sessions/')) {
      const sid = decodeURIComponent(url.slice('/api/sessions/'.length));
      deletedSids.push(sid);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.on('upgrade', (_req, socket) => {
    // No real ws — the sidebar contract under test does not depend on it.
    socket.destroy();
  });
  await new Promise<void>((r) =>
    server.listen(DAEMON_PORT, '127.0.0.1', () => r()),
  );
  return { server, token, createdSids, deletedSids };
}

async function stopMockDaemon(daemon: MockDaemon): Promise<void> {
  await new Promise<void>((r) => daemon.server.close(() => r()));
}

interface ViteHandle {
  proc: ChildProcess;
  url: string;
}

async function startVite(): Promise<ViteHandle> {
  const isWin = process.platform === 'win32';
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
      shell: isWin,
      detached: !isWin,
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
      const clean = stdoutBuf.replace(ANSI_RE, '').replace(ESC_RE, '');
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

  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else if (proc.pid !== undefined) {
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      proc.kill('SIGTERM');
    }
  } else {
    proc.kill('SIGTERM');
  }

  await Promise.race([
    exited,
    new Promise<void>((r) => setTimeout(r, 5_000)),
  ]);
  if (proc.exitCode === null) {
    if (process.platform !== 'win32' && proc.pid !== undefined) {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    } else {
      proc.kill('SIGKILL');
    }
  }
}

test('groups-sidebar — multi-session add / setActive / close', async ({
  page,
}, testInfo) => {
  test.setTimeout(90_000);

  const daemon = await startMockDaemon();
  const vite = await startVite();
  try {
    const url = `${vite.url}/?token=${encodeURIComponent(daemon.token)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // Wait for sidebar to mount.
    await page
      .locator('[data-testid="sidebar-groups"]')
      .waitFor({ state: 'attached', timeout: 10_000 });

    // ---- Stage 1: bootstrap session arrives ----
    //
    // MainPane auto-creates the first session on mount. The sidebar should
    // render exactly one session row, marked active. We use [data-active]
    // (only the `<li>` wrapper carries that attribute, the inner row/close
    // buttons don't) so the locator counts session rows, not their children.
    const rows = page.locator('[data-testid^="sidebar-session-"][data-active]');
    await rows.first().waitFor({ state: 'attached', timeout: 10_000 });
    await expect(rows).toHaveCount(1, { timeout: 5_000 });

    await snap(page, testInfo, '01-after-bootstrap');

    // ---- Stage 2: click + New Session → second row appears, active ----
    await page.locator('[data-testid="sidebar-new-session"]').click();
    await expect(rows).toHaveCount(2, { timeout: 5_000 });

    // The newest row should be active (addSession auto-promotes).
    const activeRows = page.locator(
      '[data-testid^="sidebar-session-"][data-active="true"]',
    );
    await expect(activeRows).toHaveCount(1);

    // Capture the sids in DOM order for the click-to-setActive step.
    const allSids = await rows.evaluateAll((els) =>
      els.map((el) =>
        (el.getAttribute('data-testid') ?? '').replace('sidebar-session-', ''),
      ),
    );
    expect(allSids).toHaveLength(2);
    const [firstSid, secondSid] = allSids as [string, string];

    // Sanity: second row is the active one right now.
    const secondRow = page.locator(`[data-testid="sidebar-session-${secondSid}"]`);
    await expect(secondRow).toHaveAttribute('data-active', 'true');

    await snap(page, testInfo, '02-after-second-create');

    // ---- Stage 3: click first row → it becomes active ----
    await page
      .locator(`[data-testid="sidebar-session-row-${firstSid}"]`)
      .click();
    const firstRow = page.locator(`[data-testid="sidebar-session-${firstSid}"]`);
    await expect(firstRow).toHaveAttribute('data-active', 'true', {
      timeout: 5_000,
    });
    await expect(secondRow).toHaveAttribute('data-active', 'false');

    await snap(page, testInfo, '03-after-setActive-first');

    // ---- Stage 4: hover + click × on first row → 1 row left, second active ----
    await firstRow.hover();
    await page
      .locator(`[data-testid="sidebar-session-close-${firstSid}"]`)
      .click();

    await expect(rows).toHaveCount(1, { timeout: 5_000 });
    // The surviving row is the second-created one, and closeSession's slot
    // rotation rule means it became active.
    await expect(
      page.locator(`[data-testid="sidebar-session-${secondSid}"]`),
    ).toHaveAttribute('data-active', 'true');

    // Daemon received the DELETE for the right sid.
    expect(daemon.deletedSids).toContain(firstSid);

    const final = await snap(page, testInfo, '04-after-close-first');

    // ---- Acceptance: PNG/TXT artifacts non-trivial ----
    const pngStat = statSync(final.pngPath);
    expect(pngStat.size).toBeGreaterThan(1_000);
    const txt = readFileSync(final.txtPath, 'utf8');
    expect(txt).toContain('sidebar-groups');
    expect(txt).toContain(`sidebar-session-${secondSid}`);
    expect(txt).not.toContain('[pageerror]');

    // eslint-disable-next-line no-console -- intentional manager-facing log
    console.log(`[groups-sidebar-spec] PNG: ${final.pngPath}`);
    // eslint-disable-next-line no-console
    console.log(`[groups-sidebar-spec] TXT: ${final.txtPath}`);
  } finally {
    await stopVite(vite);
    await stopMockDaemon(daemon);
  }
});
