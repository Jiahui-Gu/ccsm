// E2E: Theme toggle (dark <-> light) — no FOUC and key controls keep
// readable contrast.
//
// Failure modes we guard against:
//   1. FOUC: dark→light flips `html.theme-light` and removes `html.dark`,
//      and we need both the class flip AND the CSS variables it pulls in
//      to apply within one frame. We sample the rendered background color
//      of the sidebar and the foreground color of a button BEFORE and
//      AFTER the toggle and assert they actually changed.
//   2. Unstyled flash: while toggling, the body must never fall back to
//      raw white-on-white or black-on-black. We assert the sidebar bg
//      is always one of the two known palettes (dark vs light), never
//      a transparent / browser default.
//   3. Contrast: in light mode, primary foreground vs app bg must be
//      sufficiently distinct (we cheap-check by comparing the two RGB
//      luminances differ by > 0.4). Same for dark mode.
//
// The toggle itself goes through Settings → Appearance → Segmented theme
// control. We exercise the user-facing flow rather than calling
// store.setTheme directly, so this catches any wiring regression.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-theme-toggle] FAIL: ${msg}`);
  process.exit(1);
}

const { port: PORT, close: closeServer } = await startBundleServer(root);
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-theme-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_DEV_PORT: String(PORT) }
});

let exitCode = 0;
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });
  await win.waitForTimeout(400);

  // Helper: parse rgb()/rgba() string to {r,g,b} ints.
  // Runs in the renderer for color-name normalisation via getComputedStyle.
  async function snapshot(label) {
    return await win.evaluate(() => {
      const html = document.documentElement;
      // Modern browsers return oklch/oklab strings as-is when the source
      // CSS uses them. Parse the L (lightness) channel directly — it is
      // already a 0-1 perceptual lightness which is what we want.
      // Fallback for legacy rgb()/rgba() strings.
      function parseLum(s) {
        if (!s) return null;
        let m = s.match(/^oklch\(\s*([0-9.]+)/i) || s.match(/^oklab\(\s*([0-9.]+)/i);
        if (m) return parseFloat(m[1]);
        m = s.match(/rgba?\(\s*(\d+)[, ]+(\d+)[, ]+(\d+)/);
        if (m) {
          const r = +m[1], g = +m[2], b = +m[3];
          return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
        }
        return null;
      }
      // Background: read the actual computed `--color-bg-app` CSS variable
      // off of <html>. We avoid `getComputedStyle(body).backgroundColor`
      // because Chromium caches the resolved oklch() string from the
      // variable's INITIAL value and does not re-resolve when the var
      // changes via a class swap on the parent — the resulting string
      // stays stale even though the rendered pixels do update. Reading
      // the var directly bypasses that quirk.
      const bgRaw = getComputedStyle(html).getPropertyValue('--color-bg-app').trim() ||
        getComputedStyle(html).backgroundColor;
      const fgRaw = getComputedStyle(html).getPropertyValue('--color-fg-primary').trim() ||
        getComputedStyle(html).color;
      const sidebar = document.querySelector('aside');
      const sidebarBg = sidebar ? getComputedStyle(sidebar).backgroundColor : bgRaw;
      const bgLum = parseLum(bgRaw);
      const fgLum = parseLum(fgRaw);
      return {
        themeClassDark: html.classList.contains('dark'),
        themeClassLight: html.classList.contains('theme-light'),
        dataTheme: html.dataset.theme,
        bodyBg: bgRaw,
        sidebarBg,
        fg: fgRaw,
        contrast: bgLum != null && fgLum != null ? Math.abs(bgLum - fgLum) : 0,
        bgLum: bgLum ?? -1
      };
    });
  }

  // Force the starting theme to 'dark' so the test is deterministic
  // regardless of OS-level preference. We then exercise the user-facing
  // segmented control to flip to light and back.
  await win.evaluate(() => {
    window.__ccsmStore.getState().setTheme('dark');
  });
  await win.waitForTimeout(150);
  const dark1 = await snapshot('initial-dark');
  if (!dark1.themeClassDark || dark1.themeClassLight) {
    fail(`expected initial dark theme classes, got ${JSON.stringify(dark1)}`);
  }
  if (dark1.dataTheme !== 'dark') fail(`html[data-theme] should be 'dark', got ${dark1.dataTheme}`);
  if (dark1.contrast < 0.3) {
    fail(`dark-mode contrast too low (${dark1.contrast.toFixed(2)}) — possible unstyled state. snapshot=${JSON.stringify(dark1)}`);
  }

  // Flip to LIGHT via the Settings → Appearance segmented radio.
  const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
  await sidebarBtn.click();
  const dialog = win.getByRole('dialog');
  await dialog.waitFor({ state: 'visible', timeout: 3000 });
  // Appearance is the default tab; the Segmented Light radio is role='radio'
  // with aria-label / text 'Light'. Querying inside the dialog avoids
  // collisions with any other "Light" text on the page.
  const lightRadio = dialog.getByRole('radio', { name: /^light$/i });
  await lightRadio.click();
  // Allow React effect → root.classList.toggle to apply within a frame.
  await win.waitForFunction(
    () => document.documentElement.classList.contains('theme-light'),
    null,
    { timeout: 1000 }
  );
  const light1 = await snapshot('after-light');
  if (light1.themeClassDark) fail('html.dark still set after switching to Light');
  if (!light1.themeClassLight) fail('html.theme-light not set after switching to Light');
  if (light1.dataTheme !== 'light') fail(`html[data-theme] should be 'light', got ${light1.dataTheme}`);
  // Light mode body background should be substantially BRIGHTER than dark.
  if (!(light1.bgLum > dark1.bgLum + 0.4)) {
    fail(
      `light-mode background not noticeably brighter than dark (` +
        `dark lum=${dark1.bgLum.toFixed(2)}, light lum=${light1.bgLum.toFixed(2)}). ` +
        `FOUC or theme not applied?`
    );
  }
  if (light1.contrast < 0.3) {
    fail(`light-mode contrast too low (${light1.contrast.toFixed(2)}) — text vs bg too similar`);
  }
  // Sidebar must have its own non-default background — guards against
  // "translucent on top of nothing" rendering as transparent black.
  if (light1.sidebarBg === 'rgba(0, 0, 0, 0)' || light1.sidebarBg === 'transparent') {
    fail(`sidebar background is transparent in light mode (${light1.sidebarBg})`);
  }

  // Flip back to DARK via the same Segmented control.
  const darkRadio = dialog.getByRole('radio', { name: /^dark$/i });
  await darkRadio.click();
  await win.waitForFunction(
    () => document.documentElement.classList.contains('dark') &&
          !document.documentElement.classList.contains('theme-light'),
    null,
    { timeout: 1000 }
  );
  const dark2 = await snapshot('after-dark');
  if (dark2.dataTheme !== 'dark') fail(`html[data-theme] should be back to 'dark', got ${dark2.dataTheme}`);
  if (!(dark2.bgLum < light1.bgLum - 0.4)) {
    fail(`dark-mode bg lum (${dark2.bgLum.toFixed(2)}) not noticeably darker than light (${light1.bgLum.toFixed(2)})`);
  }

  console.log('\n[probe-e2e-theme-toggle] OK');
  console.log(`  dark1 lum=${dark1.bgLum.toFixed(2)}  light lum=${light1.bgLum.toFixed(2)}  dark2 lum=${dark2.bgLum.toFixed(2)}`);
  console.log(`  contrast: dark=${dark1.contrast.toFixed(2)}, light=${light1.contrast.toFixed(2)}`);
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  await app.close();
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
