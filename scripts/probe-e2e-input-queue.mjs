// E2E: CLI-style message queue + Esc interrupt.
//
// Flow:
//   1. New session, picks cwd via stubbed dialog.
//   2. Sends a long-running prompt (so the agent stays "running" long enough
//      to type a follow-up).
//   3. While the first turn is in flight, types a second message and presses
//      Enter. This must NOT call agentSend yet — it must enqueue.
//   4. Asserts the "+1 queued" chip appears in the DOM.
//   5. Waits for the first turn's assistant reply to finish.
//   6. Asserts the second message renders as a user echo (auto-drained from
//      the queue) and we eventually see a second assistant reply.
//
// Esc-to-interrupt is exercised separately by sending one prompt, hitting Esc
// while it streams, and asserting agentInterrupt was invoked + the running
// flag clears.
//
// Pure black-box on the renderer side — no store reads.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const FAKE_CWD = root;

function fail(msg) {
  console.error(`\n[probe-e2e-input-queue] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, FAKE_CWD);

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Open a session.
const newBtn = win.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15_000 }).catch(async () => {
  await app.close();
  fail('"New Session" button not visible');
});
await newBtn.click();

const textarea = win.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('textarea did not appear'));

// Pick a cwd so agent:start has a valid working dir.
const cwdChip = win.locator('[data-cwd-chip]').first();
await cwdChip.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('cwd chip not found'));
await cwdChip.click();
const browseItem = win.getByText('Browse folder…').first();
await browseItem.waitFor({ state: 'visible', timeout: 3000 });
await browseItem.click();
await win.waitForTimeout(400);

// Turn 1: a long-ish prompt that gives us time to queue something.
await textarea.click();
await textarea.fill('count slowly from one to fifteen, one number per line');
await win.keyboard.press('Enter');

// Wait for the Stop button to appear — that's the visible signal that the
// agent is now "running".
const stopBtn = win.getByRole('button', { name: /^stop$/i });
await stopBtn.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => fail('Stop button never appeared — agent did not start'));

// While running, type a follow-up and press Enter. Must enqueue, not send.
await textarea.click();
await textarea.fill('also reply with the single word: queued-pong');
await win.keyboard.press('Enter');

// The +N queued chip is the contract that the message landed in the FIFO.
const chip = win.getByText(/\+1 queued/);
await chip.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body text at failure ---\n' + dump);
  await app.close();
  fail('"+1 queued" chip never appeared after Enter during running turn');
});

// Wait for the queued message to be auto-drained. The chip disappears when
// the queue empties (post-drain).
await chip.waitFor({ state: 'hidden', timeout: 90_000 }).catch(() => fail('queued message was not drained within 90s (chip never went away)'));

// Look for the queued user-echo text in the chat — proves the drained turn
// re-entered the normal send path.
const queuedEcho = win.getByText('also reply with the single word: queued-pong').first();
const visible = await queuedEcho.isVisible().catch(() => false);
if (!visible) {
  await app.close();
  fail('queued user-echo missing from chat after drain');
}

// And eventually a second assistant reply should appear (queued-pong or similar).
// We don't assert on exact content — model wording can vary — but we wait for
// the Stop button to disappear at least once after the drain, signalling the
// second turn completed.
await stopBtn.waitFor({ state: 'hidden', timeout: 60_000 }).catch(() => fail('second (drained) turn never finished'));

console.log('\n[probe-e2e-input-queue] OK');
console.log('  +1 queued chip:    visible during running turn');
console.log('  drain after turn:  user echo rendered, second turn completed');

await app.close();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
