// scripts/dogfood-bug-66-screenshot.mjs
//
// Bug #66 / PR #1385: capture before/after chromium screenshots of the
// warm-switch scrollbar. Identical setup to dogfood-pr-1374-warm-scroll-
// preserved.mjs, but writes PNGs to docs/screenshots/bug-66/ for PR
// review. Exit 0 always (this is a screenshot artifact, not a gate).

import { mkdtempSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tempDir = mkdtempSync(path.join(tmpdir(), 'ccsm-bug66-shot-'));
  createIsolatedClaudeDir(tempDir);
  const outDir = path.join(process.cwd(), 'docs', 'screenshots', 'bug-66');
  mkdirSync(outDir, { recursive: true });

  const { electronApp, win } = await launchCcsmIsolated({ tempDir });
  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid: sidA } = await seedSession(win, { name: 'A', cwd: tempDir });
    const { sid: sidB } = await seedSession(win, { name: 'B', cwd: tempDir });

    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
    await dismissWelcomeSplash(win);

    await win.evaluate(() => {
      const t = window.__ccsmTerm;
      t.write('\x1b[?1049l');
      for (let i = 0; i < 200; i++) t.write(`bug66-shot ${i}\r\n`);
      t.scrollLines(-40);
    });
    await sleep(300);

    await win.screenshot({ path: path.join(outDir, 'before-switch.png') });
    console.log('captured before-switch.png');

    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidB);
    await waitForTerminalReady(win, sidB, { timeout: 30000 });
    await sleep(300);

    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sidA);
    await waitForTerminalReady(win, sidA, { timeout: 30000 });
    await sleep(600);

    await win.screenshot({ path: path.join(outDir, 'after-switch.png') });
    console.log('captured after-switch.png');
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
