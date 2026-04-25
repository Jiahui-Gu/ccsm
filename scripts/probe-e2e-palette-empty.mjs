// E2E: command palette empty state.
//
// When the user opens the palette (Cmd/Ctrl+F), it must show ONLY the search
// input — no results list, no command suggestions. Results appear only after
// the user types at least one non-whitespace character. Esc closes it.
//
// This is the literal repro of #117 ("show only search input until user
// types"): a regression there would render the full command list immediately
// on open, defeating the point of a search-driven palette.
//
// Pure black-box: keyboard + DOM reads. Isolated userData per run.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-palette-empty] FAIL: ${msg}`);
  process.exit(1);
}

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-palette-empty-'));

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

try { // ccsm-probe-cleanup-wrap

const errors = [];
const win = await appWindow(app);
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10_000 });

// Seed a session + group so the palette has something it COULD show — that
// way the empty-state assertion is meaningful (we're saying "even though
// matches exist, none should render until the user types").
await win.evaluate(() => {
  window.__ccsmStore.setState({
    sessions: [
      {
        id: 's-palette-1',
        name: 'Alpha session',
        state: 'idle',
        cwd: '~/alpha',
        model: 'claude-opus-4',
        groupId: 'g-default',
        agentType: 'claude-code'
      }
    ],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: 's-palette-1',
    tutorialSeen: true
  });
});
await win.waitForTimeout(200);

// 1. Open palette via Cmd+F (Ctrl+F on Win/Linux). The App.tsx handler
//    listens on window 'keydown' with metaKey || ctrlKey, so synthesizing the
//    DOM event is the closest analogue to a real keypress.
await win.evaluate(() => {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'f', code: 'KeyF', ctrlKey: true, bubbles: true })
  );
});

// Search input is the only <input> rendered by CommandPalette.
const searchInput = win.locator('input[placeholder*="Search"]');
await searchInput.waitFor({ state: 'visible', timeout: 3000 }).catch(async () => {
  await app.close();
  fail('palette did not open via Ctrl+F — search input never appeared');
});

// 2. Empty state: NO option rows should be present INSIDE the palette. The
//    sidebar also exposes session items as role="option" (DnD-kit sortable),
//    so we must scope the query to the palette dialog. The CommandPalette
//    portals into a Radix Dialog (role="dialog") and renders a <ul
//    role="listbox"> inside it.
const paletteDialog = win.locator('[role="dialog"]').filter({ has: win.locator('input[placeholder*="Search"]') });
const paletteOptions = paletteDialog.locator('[role="option"]');
const optionsBeforeType = await paletteOptions.count();
if (optionsBeforeType !== 0) {
  await app.close();
  fail(`palette rendered ${optionsBeforeType} option(s) on open; expected 0 until user types`);
}

// The empty hint string from i18n (en) — sanity check the empty-state copy is
// actually what greets the user (not a stale "No matches" or worse).
const hintVisible = await win.getByText(/Type to search/i).isVisible().catch(() => false);
if (!hintVisible) {
  await app.close();
  fail('empty-state hint "Type to search…" not visible on freshly-opened palette');
}

// 3. Type a character that matches the seeded session. Results should appear.
await searchInput.click();
await searchInput.fill('alpha');
await win.waitForTimeout(150);

const optionsAfterType = await paletteOptions.count();
if (optionsAfterType < 1) {
  await app.close();
  fail(`after typing "alpha", expected ≥1 option, got ${optionsAfterType}`);
}
const alphaRowVisible = await paletteOptions.filter({ hasText: 'Alpha session' }).first().isVisible();
if (!alphaRowVisible) {
  await app.close();
  fail('typing "alpha" did not surface the seeded "Alpha session" row');
}

// 3b. Kbd hint footer is always visible (#258 CP4). Three hints expected:
//     ↑↓ Navigate / ↵ Select / Esc Close.
const kbdHints = paletteDialog.locator('[data-testid="cmd-palette-kbd-hints"]');
const kbdHintsVisible = await kbdHints.isVisible().catch(() => false);
if (!kbdHintsVisible) {
  await app.close();
  fail('kbd hint row [data-testid=cmd-palette-kbd-hints] not visible (#258 CP4)');
}
const hintsText = (await kbdHints.innerText()).replace(/\s+/g, ' ').trim();
for (const expected of ['Navigate', 'Select', 'Close']) {
  if (!hintsText.includes(expected)) {
    await app.close();
    fail(`kbd hint row missing label "${expected}" — got: ${hintsText}`);
  }
}

// 3c. No-matches state (#258 CP3). Type a query that matches nothing — the
//     palette must render the dedicated no-matches block (icon + "No matches"
//     + the typed query), NOT the dim plain-text fallback.
await searchInput.fill('zzz-no-such-thing-zzz');
await win.waitForTimeout(150);
const noMatchesBlock = paletteDialog.locator('[data-testid="cmd-palette-no-matches"]');
const noMatchesVisible = await noMatchesBlock.isVisible().catch(() => false);
if (!noMatchesVisible) {
  await app.close();
  fail('no-matches block [data-testid=cmd-palette-no-matches] not visible after typing nonsense (#258 CP3)');
}
const noMatchesText = await noMatchesBlock.innerText();
if (!noMatchesText.includes('No matches')) {
  await app.close();
  fail(`no-matches block missing "No matches" copy — got: ${noMatchesText}`);
}
if (!noMatchesText.includes('zzz-no-such-thing-zzz')) {
  await app.close();
  fail(`no-matches block did not echo the typed query — got: ${noMatchesText}`);
}
// SearchX icon is rendered as inline SVG by lucide-react; check at least one
// SVG is present inside the no-matches block.
const noMatchesSvg = await noMatchesBlock.locator('svg').count();
if (noMatchesSvg < 1) {
  await app.close();
  fail('no-matches block has no SVG icon (expected SearchX) (#258 CP3)');
}

// Reset query for the close-on-Esc check below.
await searchInput.fill('');

// 4. Esc closes the palette. Radix Dialog handles Esc itself; press it on
//    the focused search input to ensure the event reaches the dialog tree.
await searchInput.focus();
await searchInput.press('Escape');
await win.waitForTimeout(400);
const stillOpen = await searchInput.isVisible().catch(() => false);
if (stillOpen) {
  await app.close();
  fail('palette did not close on Esc');
}

console.log('\n[probe-e2e-palette-empty] OK');
console.log('  Ctrl+F opens palette');
console.log('  empty state: 0 options, "Type to search…" hint visible');
console.log(`  typing "alpha" surfaces ${optionsAfterType} option(s) including "Alpha session"`);
console.log('  kbd hint row visible with Navigate / Select / Close (#258 CP4)');
console.log('  no-matches block renders icon + "No matches" + typed query (#258 CP3)');
console.log('  Esc closes palette');

await app.close();

try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
