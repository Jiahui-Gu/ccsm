// IME composition overflow e2e probe.
//
// Verifies the architectural fix in src/styles/global.css (.xterm .xterm-helpers
// containment) + src/components/AppShell.tsx (min-w-0 overflow-hidden) prevents
// long IME composition strings from inflating .app-shell.scrollWidth and pushing
// the sidebar off-screen.
//
// Bug class: xterm.js 5.5.0 inflates .xterm-helper-textarea and .composition-view
// inline widths to match the composition string (~11200px for 800 chars).
// Although position:absolute, those widths propagate up via scrollable overflow
// to .app-shell, displacing the shrink-0 sidebar past the left viewport edge.
//
// Strategy (adapted from scratch/diagnose-ime/ime.mjs):
//   1. Launch isolated ccsm; seed a session so the xterm pane mounts.
//   2. Wait for [data-terminal-host] + .xterm-helper-textarea.
//   3. Focus the helper textarea, dispatch compositionstart.
//   4. For n in {1, 10, 50, 200, 800}, dispatch compositionupdate with
//      `'我'.repeat(n)` and assert:
//        - .app-shell.scrollWidth <= .app-shell.clientWidth + 2
//        - sidebar (aside).getBoundingClientRect().left >= -1
//        - .composition-view bounding rect width > 0 (for n >= 10)
//        - .composition-view.right <= [data-terminal-host].right + 2
//   5. Dispatch compositionend; assert .composition-view loses .active.
//
// Without the fix, step 4's scrollWidth assertion fails at n=800
// (12451 vs 1280 measured on Windows 11).

import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForTerminalReady,
  dismissFirstRunModals,
} from './probe-utils-real-cli.mjs';

const STEPS = [1, 10, 50, 200, 800];

function fail(msg) {
  console.error('[harness-ime-overflow] FAIL:', msg);
  process.exitCode = 1;
}

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const { electronApp, win } = await launchCcsmIsolated({ tempDir });

  try {
    await win.waitForFunction(
      () => !document.querySelector('[data-testid="claude-availability-probing"]'),
      null,
      { timeout: 30000 },
    );

    const { sid } = await seedSession(win, { name: 'ime-overflow', cwd: tempDir });
    if (!sid) throw new Error('seedSession returned empty sid');

    await new Promise((r) => setTimeout(r, 4000));
    await waitForTerminalReady(win, sid, { timeout: 60000 });
    await dismissFirstRunModals(win);

    // Ensure terminal is focused so .xterm-helper-textarea is active.
    await win.evaluate(() => {
      const host = document.querySelector('[data-terminal-host]');
      host?.click();
      const ta = document.querySelector('.xterm-helper-textarea');
      ta?.focus();
    });
    await new Promise((r) => setTimeout(r, 300));

    const taReady = await win.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      if (!ta) return { ok: false, reason: 'no textarea' };
      ta.focus();
      return { ok: document.activeElement === ta };
    });
    if (!taReady.ok) {
      throw new Error(`xterm-helper-textarea not focusable: ${JSON.stringify(taReady)}`);
    }

    // Start composition.
    await win.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new CompositionEvent('compositionstart', { data: '', bubbles: true }));
    });

    let failures = 0;
    for (const n of STEPS) {
      await win.evaluate((count) => {
        const ta = document.querySelector('.xterm-helper-textarea');
        const data = '我'.repeat(count);
        ta.value = data;
        ta.dispatchEvent(new CompositionEvent('compositionupdate', { data, bubbles: true }));
        ta.dispatchEvent(
          new InputEvent('input', {
            data,
            inputType: 'insertCompositionText',
            bubbles: true,
          }),
        );
      }, n);
      // xterm CompositionHelper schedules a setTimeout 0 to reposition
      // .composition-view; give it time to settle.
      await new Promise((r) => setTimeout(r, 150));

      const metrics = await win.evaluate(() => {
        const appShell = document.querySelector('.app-shell');
        const sidebar = document.querySelector('aside');
        const host = document.querySelector('[data-terminal-host]');
        const helpers = document.querySelector('.xterm-helpers');
        const view = document.querySelector('.composition-view');
        const helpersRect = helpers?.getBoundingClientRect();
        return {
          appShellScroll: appShell?.scrollWidth ?? 0,
          appShellClient: appShell?.clientWidth ?? 0,
          sidebarLeft: sidebar ? sidebar.getBoundingClientRect().left : -9999,
          hostRight: host ? host.getBoundingClientRect().right : 0,
          // .xterm-helpers is the clip box (overflow:hidden + contain:layout
          // applied by our fix). Its right edge bounds where .composition-view
          // is actually painted, regardless of the view element's own natural
          // width (which xterm sets to the composition string's pixel length).
          helpersRight: helpersRect ? helpersRect.right : 0,
          helpersOverflow: helpers ? getComputedStyle(helpers).overflow : '',
          helpersContain: helpers ? getComputedStyle(helpers).contain : '',
          viewWidth: view ? view.getBoundingClientRect().width : 0,
          viewActive: view ? view.classList.contains('active') : false,
        };
      });

      console.log(`[harness-ime-overflow] n=${n}`, metrics);

      if (metrics.appShellScroll > metrics.appShellClient + 2) {
        fail(
          `n=${n}: appShell.scrollWidth ${metrics.appShellScroll} > clientWidth ${metrics.appShellClient}+2 (containment broken)`,
        );
        failures++;
      }
      if (metrics.sidebarLeft < -1) {
        fail(`n=${n}: sidebar.left ${metrics.sidebarLeft} pushed off viewport`);
        failures++;
      }
      if (n >= 10) {
        if (!(metrics.viewWidth > 0)) {
          fail(`n=${n}: .composition-view width ${metrics.viewWidth} not visible (containment too aggressive?)`);
          failures++;
        }
        // The clip box (.xterm-helpers) must stay within the terminal host's
        // right edge. The composition-view's own bounding rect can be wider
        // (xterm 5.5.0 sets its inline width to the string's pixel length),
        // but our overflow:hidden + contain:layout on .xterm-helpers ensures
        // only the head is painted within the terminal area.
        if (metrics.helpersRight > metrics.hostRight + 2) {
          fail(
            `n=${n}: .xterm-helpers clip box right ${metrics.helpersRight} > terminal-host.right ${metrics.hostRight}+2 (clip box escapes terminal)`,
          );
          failures++;
        }
        if (!/hidden/.test(metrics.helpersOverflow)) {
          fail(`n=${n}: .xterm-helpers overflow=${metrics.helpersOverflow} (expected hidden)`);
          failures++;
        }
        if (!/layout/.test(metrics.helpersContain)) {
          fail(`n=${n}: .xterm-helpers contain=${metrics.helpersContain} (expected layout)`);
          failures++;
        }
      }
    }

    // End composition.
    await win.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea');
      ta.dispatchEvent(new CompositionEvent('compositionend', { data: '', bubbles: true }));
      ta.value = '';
    });
    await new Promise((r) => setTimeout(r, 200));

    const endState = await win.evaluate(() => {
      const v = document.querySelector('.composition-view');
      return { active: v ? v.classList.contains('active') : false };
    });
    if (endState.active) {
      fail(`composition-view still .active after compositionend: ${JSON.stringify(endState)}`);
      failures++;
    }

    if (failures === 0) {
      console.log('[harness-ime-overflow] PASS — all containment assertions held across', STEPS);
    } else {
      console.error(`[harness-ime-overflow] ${failures} assertion failure(s)`);
    }
  } finally {
    try { await electronApp.close(); } catch (_) { /* ignore */ }
  }
}

main().catch((e) => {
  console.error('[harness-ime-overflow] FAILED:', e);
  process.exit(1);
});
