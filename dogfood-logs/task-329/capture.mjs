// Capture before/after screenshots for task #329 first-run empty state.
// Usage:
//   node dogfood-logs/task-329/capture.mjs after   # capture against current build
//   node dogfood-logs/task-329/capture.mjs before  # checkout prev rev first
//
// Requires `npm run build` first — we serve the prebuilt bundle from
// dist/renderer/ via a one-shot static server, mirroring the harness pattern.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from '../../scripts/probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..', '..');
const label = process.argv[2] || 'after';

const { port, close: closeServer } = await startBundleServer(root);
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    // Force the main process to take the production loadFile() branch even
    // though we're unpackaged — that path resolves to dist/renderer which
    // we built and serve via startBundleServer above. CCSM_DEV_PORT is set
    // for completeness but the prod branch ignores it.
    CCSM_PROD_BUNDLE: '1',
    CCSM_DEV_PORT: String(port)
  }
});
try {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });
  // Give the renderer time to mount + hydrate before we mutate state.
  await win.waitForTimeout(1500);

  // Force fresh empty + tutorialSeen so we render the bare CTA palette.
  await win.evaluate(() => {
    window.__ccsmStore.setState({
      sessions: [],
      activeId: '',
      focusedGroupId: null,
      tutorialSeen: true,
      messagesBySession: {}
    });
  });
  // Wait for the empty-state DOM to land. We poll for either the
  // first-run-empty test id (after) or the legacy New Session button (before).
  await win.waitForFunction(
    () =>
      !!document.querySelector('[data-testid="first-run-empty"]') ||
      Array.from(document.querySelectorAll('button')).some(
        (b) => /^(New Session|New session)$/.test((b.textContent || '').trim())
      ),
    null,
    { timeout: 10000 }
  );
  await win.waitForTimeout(400);

  const out = path.join(__dirname, `${label}.png`);
  await win.screenshot({ path: out, fullPage: true });
  console.log(`saved ${out}`);
} finally {
  await app.close();
  closeServer();
}
