// scripts/dogfood-dev-process-distinguishable.mjs
//
// PR-scoped probe (task #50): under CCSM_DEV=1, the running Electron
// app must self-identify as "CCSM (dev)" (app.getName()) and tag the
// main BrowserWindow title as "CCSM [dev]". Without this, Windows
// tasklist / Alt-Tab / Task Manager show the dev process and the
// installed CCSM under the same name and accidental
// `taskkill /IM CCSM.exe` blasts the user's working session
// (incident on 2026-05-25 — see feedback_never_blind_kill_ccsm.md).
//
// Exit 0 = PASS, 1 = FAIL.

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { _electron as electron } from 'playwright';

async function main() {
  const userDataDir = mkdtempSync(path.join(tmpdir(), 'ccsm-dogfood-50-'));
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: process.cwd(),
    env: {
      ...process.env,
      CCSM_DEV: '1',
      // Stay offscreen so this dogfood never pops a window on the
      // user's desktop. Same convention as scripts/probe-utils-real-cli.
      CCSM_E2E_HIDDEN: '1',
      CCSM_E2E_NO_SINGLE_INSTANCE: '1',
    },
  });

  try {
    const win = await app.firstWindow();
    await win.waitForLoadState('domcontentloaded');
    // Let main settle so app.whenReady ran and setName took effect.
    await new Promise((r) => setTimeout(r, 1500));

    const appName = await app.evaluate(({ app }) => app.getName());
    const winTitle = await app.evaluate(({ BrowserWindow }) => {
      const w = BrowserWindow.getAllWindows()[0];
      return w?.getTitle() ?? '';
    });

    console.log(`app.getName() = ${JSON.stringify(appName)}`);
    console.log(`window.title  = ${JSON.stringify(winTitle)}`);

    const okName = appName.includes('dev') || appName.includes('Dev');
    const okTitle = /\[dev\]/i.test(winTitle);

    if (!okName) {
      console.error(`FAIL: app.getName() should include dev marker, got ${JSON.stringify(appName)}`);
    }
    if (!okTitle) {
      console.error(`FAIL: window title should include [dev], got ${JSON.stringify(winTitle)}`);
    }
    if (okName && okTitle) {
      console.log('PASS');
    } else {
      process.exitCode = 1;
    }
  } finally {
    await app.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
