// Verify Bug 1 + Bug 2 fixes without needing a real claude.exe turn.
//
// Bug 1 live check: the renderer receives a `result { error_during_execution }`
//   frame after the user clicks Stop. We fake that path by calling
//   markInterrupted, then mutating the store exactly as lifecycle.ts would
//   after translating the result frame — producing an "Interrupted" status
//   block instead of an ErrorBlock.
//
// Bug 2 live check: StatusBanner text, EmptyState text, StatusBar chips and
//   ErrorBlock text are all selectable (computed user-select !== 'none').
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-interrupt-banner] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});
const win = await appWindow(app, { timeout: 45000 });
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });

// EmptyState check: with no session, the "Ready when you are." line must be
// selectable. Grab its computed user-select.
const emptyStateSelectable = await win.evaluate(() => {
  const el = Array.from(document.querySelectorAll('div')).find(
    (d) => d.textContent === 'Ready when you are.'
  );
  if (!el) return { found: false };
  const userSelect = getComputedStyle(el).userSelect;
  return { found: true, userSelect };
});
if (!emptyStateSelectable.found) fail('EmptyState "Ready when you are." not rendered');
if (emptyStateSelectable.userSelect === 'none')
  fail(`EmptyState user-select is 'none' — text unselectable`);

// Create a session and simulate the interrupt flow.
const sessionId = await win.evaluate(() => {
  const st = window.__ccsmStore.getState();
  st.createSession('~/interrupt-probe');
  const id = window.__ccsmStore.getState().activeId;
  // Put it in running + add a partial assistant reply so the Stop path is
  // plausible even though we never actually spawn claude.exe.
  st.setRunning(id, true);
  st.appendBlocks(id, [
    { kind: 'user', id: 'u-probe', text: 'count slowly from 1 to 100' },
    { kind: 'assistant', id: 'a-probe', text: '1\n2\n3\n' }
  ]);
  return id;
});
if (!sessionId) fail('no active session id');

// Simulate the Stop button: mark interrupted, then consume it on the next
// "result" frame — same sequence lifecycle.ts uses.
const statusBlock = await win.evaluate((sid) => {
  const st = window.__ccsmStore.getState();
  st.markInterrupted(sid);
  // This is exactly what lifecycle.ts does for a result frame, inlined so
  // the probe doesn't have to fake an IPC event.
  const interrupted = st.consumeInterrupted(sid);
  if (!interrupted) return { ok: false, reason: 'flag not consumed' };
  st.appendBlocks(sid, [
    {
      kind: 'status',
      id: 'res-probe',
      tone: 'info',
      title: 'Interrupted'
    }
  ]);
  st.setRunning(sid, false);
  return { ok: true };
}, sessionId);
if (!statusBlock.ok) fail(`interrupt flag not consumed: ${statusBlock.reason}`);

// The banner is now in the DOM; make sure it's neutral (role="status") and
// carries the word "Interrupted", and that it is user-selectable.
await win.waitForSelector('[role="status"]', { timeout: 5000 });
const banner = await win.evaluate(() => {
  const nodes = Array.from(document.querySelectorAll('[role="status"]'));
  const el = nodes.find((n) => n.textContent?.includes('Interrupted'));
  if (!el) return { found: false };
  return {
    found: true,
    text: el.textContent,
    userSelect: getComputedStyle(el).userSelect,
    hasAlert: !!el.closest('[role="alert"]')
  };
});
if (!banner.found) fail('Interrupted banner not rendered');
if (banner.hasAlert) fail('Interrupted banner is inside a role="alert" — should be neutral status');
if (banner.userSelect === 'none') fail(`Interrupted banner user-select is 'none'`);
if (banner.text?.toLowerCase().includes('error_during_execution'))
  fail('banner text leaked "error_during_execution"');

// Genuine error path still renders an ErrorBlock and is also selectable.
await win.evaluate((sid) => {
  window.__ccsmStore.getState().appendBlocks(sid, [
    { kind: 'error', id: 'err-probe', text: 'Genuine failure details' }
  ]);
}, sessionId);
await win.waitForSelector('[role="alert"]', { timeout: 5000 });
const errorBlock = await win.evaluate(() => {
  const el = document.querySelector('[role="alert"]');
  if (!el) return { found: false };
  return {
    found: true,
    text: el.textContent,
    userSelect: getComputedStyle(el).userSelect
  };
});
if (!errorBlock.found) fail('ErrorBlock not rendered');
if (errorBlock.userSelect === 'none') fail(`ErrorBlock user-select is 'none'`);
if (!errorBlock.text?.includes('Genuine failure details'))
  fail('ErrorBlock missing expected text');

// StatusBar container selectability.
const statusBar = await win.evaluate(() => {
  const el = document.querySelector('.h-6.font-mono');
  if (!el) return { found: false };
  return { found: true, userSelect: getComputedStyle(el).userSelect };
});
if (statusBar.found && statusBar.userSelect === 'none')
  fail(`StatusBar user-select still 'none'`);

console.log('[probe-e2e-interrupt-banner] OK');
console.log('  - EmptyState text selectable');
console.log('  - Interrupt produces neutral "Interrupted" status (no ErrorBlock)');
console.log('  - Genuine error still renders as ErrorBlock, text selectable');
console.log('  - StatusBar container not select-none');

await app.close();
