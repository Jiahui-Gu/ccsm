// E2E probe: send/stop morph button + @file mention picker.
//
// Layered checks (no live LLM call needed; we drive the store directly):
//   1. Morph button renders Send affordance idle, switches to Stop when
//      `runningSessions[id]` flips true. Same DOM slot, swapped variant.
//   2. Typing `@` in the textarea opens the mention picker (listbox role
//      "File mentions"); Esc dismisses it without altering the textarea.
//   3. Stubbing window.ccsm.files.list with a known file list, picking
//      a row via Enter splices `@<path> ` into the textarea.
//
// Mirrors the harness pattern in `probe-e2e-inputbar-visible.mjs` —
// drives __ccsmStore directly so no claude.exe spin-up is needed.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg, app) {
  console.error(`\n[probe-e2e-composer-morph-mention] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' },
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);

await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10_000 });

// Stub window.ccsm.files.list BEFORE we mount a session so the InputBar's
// initial refreshMentionFiles() picks up the fake file list.
await win.evaluate(() => {
  const w = /** @type {any} */ (window);
  // Preserve any real bridge methods (we only override files.list).
  const realCcsm = w.ccsm ?? {};
  w.ccsm = {
    ...realCcsm,
    files: {
      list: async () => [
        { path: 'src/components/InputBar.tsx', name: 'InputBar.tsx' },
        { path: 'src/components/MentionPicker.tsx', name: 'MentionPicker.tsx' },
        { path: 'README.md', name: 'README.md' },
      ],
    },
  };
});

// Seed a single idle session so the InputBar mounts.
await win.evaluate(() => {
  const store = /** @type {any} */ (window).__ccsmStore;
  if (!store) throw new Error('__ccsmStore not on window — dev build?');
  store.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [
      {
        id: 's1',
        name: 's',
        state: 'idle',
        cwd: 'C:/x',
        model: 'claude',
        groupId: 'g1',
        agentType: 'claude-code',
      },
    ],
    activeId: 's1',
    messagesBySession: { s1: [] },
    startedSessions: { s1: true },
    runningSessions: {},
    messageQueues: {},
  });
});

await win.waitForTimeout(300);

const ta = win.locator('textarea').first();
try {
  await ta.waitFor({ state: 'visible', timeout: 5000 });
} catch {
  fail('textarea did not appear', app);
}

// ── 1. Morph button: idle = Send (primary), running = Stop (danger) ───────
let morph = win.locator('button[data-morph-state]').first();
let morphState = await morph.getAttribute('data-morph-state');
let morphVariant = await morph.getAttribute('data-variant');
if (morphState !== 'send' || morphVariant !== 'primary') {
  fail(`expected idle morph button send/primary; got ${morphState}/${morphVariant}`, app);
}

// Flip the session to running and verify the same morph button reflects Stop.
await win.evaluate(() => {
  const store = /** @type {any} */ (window).__ccsmStore;
  store.setState({ runningSessions: { s1: true } });
});
await win.waitForTimeout(350); // morph tween ~230ms

morph = win.locator('button[data-morph-state]').first();
morphState = await morph.getAttribute('data-morph-state');
morphVariant = await morph.getAttribute('data-variant');
if (morphState !== 'stop' || morphVariant !== 'danger') {
  fail(`expected running morph button stop/danger; got ${morphState}/${morphVariant}`, app);
}
const morphLabel = await morph.getAttribute('aria-label');
if (!morphLabel || !/stop/i.test(morphLabel)) {
  fail(`expected aria-label including "Stop"; got ${JSON.stringify(morphLabel)}`, app);
}

// Restore idle so the @mention picker subtests don't fight with running UI.
await win.evaluate(() => {
  const store = /** @type {any} */ (window).__ccsmStore;
  store.setState({ runningSessions: {} });
});
await win.waitForTimeout(200);

// ── 2. @ trigger opens picker; Esc dismisses ──────────────────────────────
await ta.click();
await win.keyboard.type('@');
await win.waitForTimeout(200);

let picker = win.getByRole('listbox', { name: /file mentions/i });
try {
  await picker.waitFor({ state: 'visible', timeout: 3000 });
} catch {
  const html = await win.evaluate(() => document.body.innerHTML.slice(0, 1500));
  console.error('--- body snippet ---\n' + html);
  fail('mention picker did not open after typing @', app);
}

await win.keyboard.press('Escape');
await win.waitForTimeout(200);
const stillOpen = await picker.isVisible().catch(() => false);
if (stillOpen) fail('mention picker did not dismiss on Esc', app);
const valueAfterEsc = await ta.inputValue();
if (valueAfterEsc !== '@') fail(`Esc altered textarea value: ${JSON.stringify(valueAfterEsc)}`, app);

// ── 3. Reopen + Enter inserts @<path> ─────────────────────────────────────
// The picker re-arms on any edit. Append+remove a char to bump the dismissed
// flag without changing the @ trigger.
await win.keyboard.type(' ');
await win.keyboard.press('Backspace');
await win.waitForTimeout(150);

picker = win.getByRole('listbox', { name: /file mentions/i });
try {
  await picker.waitFor({ state: 'visible', timeout: 3000 });
} catch {
  fail('mention picker did not reopen after edit re-arm', app);
}

await win.keyboard.press('Enter');
await win.waitForTimeout(200);

const finalValue = await ta.inputValue();
// Highlighted row 0 with empty query is the first stubbed file.
if (finalValue !== '@src/components/InputBar.tsx ') {
  fail(`expected '@src/components/InputBar.tsx '; got ${JSON.stringify(finalValue)}`, app);
}

console.log('\n[probe-e2e-composer-morph-mention] OK');
console.log('  morph button: idle=send/primary -> running=stop/danger');
console.log('  @mention picker: open / Esc-dismiss / Enter-commit all verified');

await app.close();
