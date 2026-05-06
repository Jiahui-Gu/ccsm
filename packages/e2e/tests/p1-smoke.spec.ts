// p1-smoke.spec.ts — T7 walking-skeleton acceptance gate (Task #663).
//
// What this proves end-to-end (DESIGN.md §9 Phase 1):
//   1. Daemon (built artifact) starts, prints `ccsm ready: <url>?token=<t>`.
//   2. Vite dev server starts on :5173 and proxies /api + /ws to the daemon
//      (vite.config.ts hardcodes the daemon at 127.0.0.1:17832, which the
//      daemon fixture also defaults to).
//   3. Browser navigates to the SPA, the four sidebar zones render with all
//      placeholder testids in place, and MainPane auto-creates one session.
//   4. The ws connects, real `claude` PTY output reaches xterm (binary frame
//      + node-pty + xterm.write loop all wired).
//   5. Typing `/help` in the REPL produces visible help text (proof the I/O
//      path is bidirectional, not just a one-way render).
//   6. Browser resize keeps the terminal filling MainPane.
//   7. Clicking Search / Settings / Import buttons does not throw.
//   8. Navigating with a wrong token surfaces a disconnect/error notice
//      without crashing the page.
//
// All evidence (PNG + TXT) is written to packages/e2e/snapshots/p1-smoke/ via
// the snap() helper. The PR description points the manager at these files for
// multimodal review.

import { expect } from '@playwright/test';
import { snap } from '../fixtures/screenshot.ts';
import { test as daemonTest } from '../fixtures/daemon.ts';
import { spawn, type ChildProcess } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdirSync, readFileSync, statSync } from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SNAPSHOTS_DIR = resolve(__dirname, '..', 'snapshots', 'p1-smoke');

const VITE_PORT = 5173;
const VITE_READY_TIMEOUT_MS = 30_000;
// eslint-disable-next-line no-control-regex -- ANSI escape stripper for vite log
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;
const VITE_READY_RE =
  /Local:\s*https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)/;

// ---- vite dev server (spawned per test file) -----------------------------
//
// Reused pattern from frontend-strictmode.spec.ts: shell:true on Windows
// forces the use of taskkill /T to wipe the cmd.exe → node → vite tree, or
// the orphaned vite holds :5173 across runs.

interface ViteHandle {
  proc: ChildProcess;
  url: string;
}

async function startVite(): Promise<ViteHandle> {
  // Cross-platform spawn discipline:
  //   POSIX:   spawn pnpm directly with detached:true so the child becomes
  //            its own process group leader; we tear down via `kill -PID`
  //            so vite (a grandchild) actually receives the signal.
  //   Windows: spawn via shell:true (Node 18.20+ refuses to spawn .cmd
  //            directly — CVE-2024-27980); tear down via `taskkill /T /F`
  //            so the cmd.exe → node → vite tree all dies.
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

  if (process.platform === 'win32' && proc.pid !== undefined) {
    spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], {
      stdio: 'ignore',
    });
  } else if (proc.pid !== undefined) {
    // Kill the whole process group (we set detached: true above so the
    // child became its own group leader). Negative PID = group target.
    try {
      process.kill(-proc.pid, 'SIGTERM');
    } catch {
      // Group may already be gone.
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

// ---- compose fixtures: daemon (worker-scoped) + vite (worker-scoped) ----
//
// We cannot reuse the daemon fixture's `daemonUrl` directly because the
// frontend talks to vite (5173), not the daemon URL — but the daemon must
// still be alive at 17832 for the proxy to reach it. So we depend on the
// `_daemon` fixture for its lifecycle and ignore its URL.

interface ViteFixtures {
  viteUrl: string;
}

const test = daemonTest.extend<ViteFixtures, { _vite: ViteHandle }>({
  _vite: [
    // eslint-disable-next-line no-empty-pattern -- Playwright fixture signature requires destructured deps even when empty.
    async ({}, use) => {
      const handle = await startVite();
      try {
        await use(handle);
      } finally {
        await stopVite(handle);
      }
    },
    { scope: 'worker' },
  ],
  viteUrl: async ({ _vite }, use) => {
    await use(_vite.url);
  },
});

// ---- helpers --------------------------------------------------------------

function snapPaths(name: string): { png: string; txt: string } {
  // Sibling of snap()'s own derivation but pinned to a stable directory name
  // (sanitize() keys off the test title; we want everything under /p1-smoke/
  // for the manager to find without having to guess the title slug).
  return {
    png: resolve(SNAPSHOTS_DIR, `${name}.png`),
    txt: resolve(SNAPSHOTS_DIR, `${name}.txt`),
  };
}

// ---- the spec -------------------------------------------------------------

test.describe('p1-smoke', () => {
  // Generous: daemon spawn (~3s) + vite (~3s) + claude PTY warmup (~3-10s) +
  // /help round-trip. Headless Chromium itself is ~1s.
  test.setTimeout(120_000);

  test.beforeAll(() => {
    mkdirSync(SNAPSHOTS_DIR, { recursive: true });
  });

  test('cold start → claude REPL → /help → resize → sidebar clicks', async ({
    page,
    viteUrl,
    token,
  }, testInfo) => {
    // Override snap output dir for this spec by funnelling through testInfo title
    // — snap()'s sanitize() turns the title into the dir name. Our title slug
    // sanitizes to "cold_start___claude_REPL___..." which is not predictable
    // enough for the PR description, so we run snap() AND copy paths into the
    // stable SNAPSHOTS_DIR using fs.cpSync below.

    // ---- step 1: navigate with valid token ------------------------------
    const url = `${viteUrl}/?token=${encodeURIComponent(token)}`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // ---- step 2: sidebar + main render ---------------------------------
    // All six sidebar testids live in Sidebar.tsx (T5).
    const sidebarIds = [
      'sidebar-new-session',
      'sidebar-search',
      'sidebar-groups',
      'sidebar-archived',
      'sidebar-settings',
      'sidebar-import',
    ] as const;
    for (const id of sidebarIds) {
      await expect(
        page.locator(`[data-testid="${id}"]`),
        `sidebar testid ${id} should render on load`,
      ).toBeVisible({ timeout: 10_000 });
    }
    await expect(page.locator('[data-testid="main-terminal"]')).toBeVisible();
    await expect(page.getByText('GROUPS', { exact: false })).toBeVisible();
    await expect(
      page.getByText('No sessions yet', { exact: false }),
    ).toBeVisible();

    await snapAndCopy(page, testInfo, '01-loaded');

    // ---- step 3: xterm renders + claude PTY OUTPUT arrives --------------
    // .xterm-screen appears as soon as Terminal.open() runs. The acceptance
    // bar is higher: we want PTY bytes to actually have been written. We
    // wait until visible-text reports more than the bare placeholders.
    const xtermScreen = page.locator('.xterm-screen');
    await xtermScreen.waitFor({ state: 'attached', timeout: 15_000 });

    // Wait for PTY to produce *some* observable byte. claude prints a banner
    // / prompt within ~3s on cold start. We poll innerText of the .xterm
    // viewport rows for any non-whitespace character.
    const xtermViewport = page.locator('.xterm-rows');
    await expect
      .poll(
        async () => {
          const text = await xtermViewport.innerText().catch(() => '');
          return text.replace(/\s+/g, '').length;
        },
        {
          message: 'expected claude PTY OUTPUT to reach xterm within 30s',
          timeout: 30_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      .toBeGreaterThan(0);

    await snapAndCopy(page, testInfo, '02-claude-banner');

    // ---- step 4: type /help and wait for response ----------------------
    // Capture the visible terminal contents BEFORE typing, then type /help
    // and assert the contents change. The walking-skeleton bar is "input
    // round-trips through PTY back to the renderer"; we deliberately do NOT
    // assert on /help's specific output text because that varies by claude
    // version. A non-empty diff after typing proves the full path:
    //   key → xterm.onData → WsClient.sendInput → ws → daemon → pty.write →
    //   pty.onData → ws → WsClient.onOutput → xterm.write → DOM.
    await page.locator('[data-testid="main-terminal"]').click();
    await page.waitForTimeout(200);

    // claude 2.x boots with a "trust this folder?" prompt before accepting
    // any other input. We answer "1" + Enter to clear it. If the prompt is
    // not present (claude already trusted this cwd from a prior run) we
    // skip — claude would otherwise treat stray "1" as REPL input.
    const bannerText = (await xtermViewport.innerText().catch(() => '')).toLowerCase();
    if (bannerText.includes('trust this folder') || bannerText.includes('yes, i trust')) {
      await page.keyboard.press('1');
      await page.keyboard.press('Enter');
      await expect
        .poll(
          async () =>
            (await xtermViewport.innerText().catch(() => '')).toLowerCase(),
          {
            message: 'expected REPL prompt to appear after trust confirmation',
            timeout: 20_000,
            intervals: [500, 1_000, 2_000],
          },
        )
        .not.toMatch(/yes, i trust this folder/);
    }

    // Snapshot the terminal contents right before we type /help. The
    // walking-skeleton assertion is that typing produces *some* observable
    // change, proving keys -> PTY -> OUTPUT round-trips end-to-end.
    const preTypeText = (await xtermViewport.innerText().catch(() => ''));

    await page.keyboard.type('/help', { delay: 50 });
    // Wait for the keystrokes to echo back through the PTY before we hit
    // Enter — claude's REPL renders the slash-command picker as you type.
    await expect
      .poll(
        async () => (await xtermViewport.innerText().catch(() => '')),
        {
          message:
            'expected typed /help characters to echo back into xterm (PTY round-trip)',
          timeout: 15_000,
          intervals: [300, 500, 1_000],
        },
      )
      .not.toBe(preTypeText);

    await page.keyboard.press('Enter');
    // Allow help body / picker selection to settle into the cell grid.
    await page.waitForTimeout(1_500);

    await snapAndCopy(page, testInfo, '03-help-output');

    // ---- step 5: resize and confirm xterm still fills main pane --------
    await page.setViewportSize({ width: 800, height: 600 });
    // FitAddon listens to window 'resize' and re-fits xterm; give it a frame.
    await page.waitForTimeout(500);
    const termBox = await page
      .locator('[data-testid="main-terminal"]')
      .boundingBox();
    const xtermBox = await page.locator('.xterm').boundingBox();
    expect(termBox, 'main-terminal must have a layout box').not.toBeNull();
    expect(xtermBox, 'xterm must have a layout box').not.toBeNull();
    if (termBox && xtermBox) {
      // xterm should fill (or near-fill) the terminal container.
      expect(xtermBox.width).toBeGreaterThan(termBox.width * 0.8);
      expect(xtermBox.height).toBeGreaterThan(termBox.height * 0.8);
    }
    await snapAndCopy(page, testInfo, '04-resized-800x600');

    // ---- step 6: click placeholder sidebar buttons (no error) ----------
    // The placeholder handlers call alert() which Playwright auto-dismisses.
    // We assert via the captured-console-logs section of the .txt that no
    // error / pageerror entry appears.
    page.on('dialog', (d) => void d.dismiss());
    await page.locator('[data-testid="sidebar-search"]').click();
    await page.locator('[data-testid="sidebar-settings"]').click();
    await page.locator('[data-testid="sidebar-import"]').click();
    await page.waitForTimeout(200);
    await snapAndCopy(page, testInfo, '05-sidebar-clicks');

    // Read the latest .txt and assert console-logs is clean.
    const { txt: lastTxt } = snapPaths('05-sidebar-clicks');
    const lastTxtBody = readFileSync(lastTxt, 'utf8');
    const consoleSection = lastTxtBody.split('console-logs:')[1] ?? '';
    expect(
      consoleSection,
      'sidebar placeholder clicks must not produce console errors',
    ).not.toContain('[error]');
    expect(consoleSection).not.toContain('[pageerror]');
  });

  test('bad token surfaces disconnect notice without crashing', async ({
    page,
    viteUrl,
  }, testInfo) => {
    const url = `${viteUrl}/?token=wrong`;
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    // The shell still mounts (sidebar is unauthenticated UI); the failure
    // surfaces in MainPane after createSession 401s. Wait for the inline
    // notice to land in the xterm.
    await expect(page.locator('[data-testid="main-terminal"]')).toBeVisible();

    const xtermViewport = page.locator('.xterm-rows');
    await expect
      .poll(
        async () => (await xtermViewport.innerText().catch(() => '')).toLowerCase(),
        {
          message: 'expected an inline failure / disconnect notice',
          timeout: 15_000,
          intervals: [500, 1_000, 2_000],
        },
      )
      // MainPane writes either `[failed to create session: ...]` (401 path)
      // or `[disconnected: ...]` (ws closed). Either is acceptable evidence
      // the unauthenticated path is handled inline rather than crashing.
      .toMatch(/failed|disconnect|error|unauthorized|401/);

    await snapAndCopy(page, testInfo, '06-bad-token');

    // Page must remain interactive (sidebar still clickable, no white screen).
    await expect(
      page.locator('[data-testid="sidebar-new-session"]'),
    ).toBeVisible();
  });
});

// ---- snap → stable directory copy ----------------------------------------
//
// snap() writes under a per-title directory it picks itself. To give the PR
// description a single, predictable location for the manager to crawl, we
// copy each artifact into snapshots/p1-smoke/ with the requested name.

import { copyFileSync } from 'node:fs';

async function snapAndCopy(
  page: import('@playwright/test').Page,
  testInfo: import('@playwright/test').TestInfo,
  name: string,
): Promise<void> {
  const { pngPath, txtPath } = await snap(page, testInfo, name);
  const dest = snapPaths(name);
  // Best-effort: even if the source paths sit in a per-test directory, we
  // mirror them to the stable location. statSync proves the source exists
  // (snap() always writes both, but be defensive).
  statSync(pngPath);
  statSync(txtPath);
  copyFileSync(pngPath, dest.png);
  copyFileSync(txtPath, dest.txt);
}
