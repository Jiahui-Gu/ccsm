// When there are zero sessions, the main panel should render exactly two
// CTA buttons with identical variant/size/width (secondary / md / w-44).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-no-sessions-landing] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 10000 });

await win.evaluate(() => {
  window.__agentoryStore.setState({ sessions: [], activeId: undefined });
});
await win.waitForTimeout(300);

const main = win.locator('main');
const newBtn = main.getByRole('button', { name: /^New Session$/ });
const importBtn = main.getByRole('button', { name: /^Import Session$/ });
await newBtn.waitFor({ state: 'visible', timeout: 5000 });
await importBtn.waitFor({ state: 'visible', timeout: 5000 });

const geom = await Promise.all([newBtn.boundingBox(), importBtn.boundingBox()]);
const [a, b] = geom;
if (!a || !b) { await app.close(); fail('button box missing'); }
if (Math.abs(a.width - b.width) > 0.5) {
  await app.close();
  fail(`button widths differ: new=${a.width.toFixed(1)} import=${b.width.toFixed(1)}`);
}
if (Math.abs(a.height - b.height) > 0.5) {
  await app.close();
  fail(`button heights differ: new=${a.height.toFixed(1)} import=${b.height.toFixed(1)}`);
}

// The old "No sessions yet" / "Create a session to start …" copy must be gone.
const oldCopy = await win.getByText(/No sessions yet|Create a session to start|Import from Claude Code/i).count();
if (oldCopy > 0) { await app.close(); fail('legacy no-sessions copy still present'); }

console.log('\n[probe-e2e-no-sessions-landing] OK');
console.log(`  both buttons ${a.width.toFixed(1)}×${a.height.toFixed(1)}`);
await app.close();
