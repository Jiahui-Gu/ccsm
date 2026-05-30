// scripts/dogfood-scroll-btn-aligns-settings.mjs
//
// Geometry probe: the terminal's scroll-to-bottom button center Y must equal
// the sidebar Settings button center Y. Both panes bottom out at the window
// bottom, so equal center-Y means the two circular/pill controls read as
// sitting on the same horizontal line across the divider.
//
// Reads getBoundingClientRect for [data-scroll-to-bottom] and the Settings
// button, compares (top + height/2). Exit 0 = PASS, 1 = FAIL.

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
  const { tempDir } = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid } = await seedSession(win, { name: 'align', cwd: tempDir });
    await win.evaluate((id) => window.__ccsmStore.getState().selectSession(id), sid);
    await waitForTerminalReady(win, sid, { timeout: 45000 });
    await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, {
      timeout: 30000,
    }).catch(() => {});
    await dismissWelcomeSplash(win).catch(() => {});
    await sleep(400);

    const g = await win.evaluate(() => {
      const scroll = document.querySelector('[data-scroll-to-bottom]');
      // Settings button: the sidebar pill with the settings label/icon. Grab
      // the bottom-zone Button that carries the Settings glyph.
      const buttons = Array.from(document.querySelectorAll('button'));
      const settings = buttons.find((b) =>
        (b.getAttribute('aria-label') || b.textContent || '')
          .toLowerCase()
          .match(/setting|设置/),
      );
      const r = (el) => {
        if (!(el instanceof HTMLElement)) return null;
        const rect = el.getBoundingClientRect();
        return { top: rect.top, height: rect.height, centerY: rect.top + rect.height / 2 };
      };
      return { scroll: r(scroll), settings: r(settings) };
    });

    console.log(`geometry: ${JSON.stringify(g)}`);

    if (!g.scroll || !g.settings) {
      console.error(
        `FAIL: missing element — scroll=${!!g.scroll} settings=${!!g.settings}`,
      );
      process.exitCode = 1;
      return;
    }

    const d = Math.abs(g.scroll.centerY - g.settings.centerY);
    console.log(
      `scroll.centerY=${g.scroll.centerY.toFixed(2)} ` +
        `settings.centerY=${g.settings.centerY.toFixed(2)} Δ=${d.toFixed(2)}`,
    );

    if (d <= 1) {
      console.log('PASS: scroll-to-bottom center Y matches Settings center Y');
      return;
    }
    console.error(`FAIL: center Y mismatch by ${d.toFixed(2)}px (want ≤1)`);
    process.exitCode = 1;
  } finally {
    await electronApp.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
