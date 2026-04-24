// Probe: the StatusBar permission-mode chip shows the official CLI names.
//
// Strategy: render against the webpack dev server (no Electron needed — this
// is pure DOM/state). Seed one session, open each menu option, and assert the
// chip label + tooltip match the target table. Finally screenshot the chip
// in its default state for visual review.
//
// Usage: CCSM_DEV_PORT=4185 npm run dev:web (background), then
//   node scripts/probe-permission-mode-chip.mjs
import { chromium } from 'playwright';

const PORT = process.env.CCSM_DEV_PORT ?? '4185';
const URL = `http://localhost:${PORT}/`;

const EXPECTED = [
  { value: 'plan', primary: 'Plan', secondary: /Read-only analysis/i },
  { value: 'default', primary: 'Default', secondary: /Auto-approve reads\. Ask before edits and shell/i },
  { value: 'acceptEdits', primary: 'Accept Edits', secondary: /Auto-approve reads and edits\. Ask before shell/i },
  { value: 'bypassPermissions', primary: 'Bypass Permissions', secondary: /Auto-approve everything/i }
];

function fail(msg) {
  console.error(`\n[probe-permission-mode-chip] FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const errors = [];
page.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await page.goto(URL, { waitUntil: 'networkidle' });
await page.waitForSelector('aside', { timeout: 15_000 });

// Seed one session so the StatusBar chip renders.
const newBtn = page.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 10_000 });
await newBtn.click();
await page.waitForTimeout(300);

// Iterate over each expected permission value, set it in the store, then
// confirm the chip's visible label matches. This catches both the option
// table AND the chip's `primaryOf` rendering in one pass.
for (const { value, primary, secondary } of EXPECTED) {
  await page.evaluate((v) => {
    const s = window.__ccsmStore.getState();
    s.setPermission(v);
  }, value);
  await page.waitForTimeout(80);

  const chipLabel = await page.evaluate(() => {
    // Find the permission chip: it's the third ChipMenu in the status bar.
    // Grab all buttons inside the status bar (the .h-6 font-mono row) and
    // pluck the last one — cwd / model / permission, in that order.
    const bar = document.querySelector('div.h-6.px-4');
    if (!bar) return null;
    const btns = bar.querySelectorAll('button');
    const last = btns[btns.length - 1];
    if (!last) return null;
    // The chip renders: <text> + <ChevronDown /> — ChevronDown is SVG so
    // textContent is just the label. Trim to be safe.
    return { text: last.textContent?.trim() ?? '', title: last.getAttribute('title') ?? '' };
  });

  if (!chipLabel) {
    await browser.close();
    fail(`could not locate permission chip for value=${value}`);
  }
  if (chipLabel.text !== primary) {
    await browser.close();
    fail(`value=${value}: chip label expected ${JSON.stringify(primary)}, got ${JSON.stringify(chipLabel.text)}`);
  }
  if (!chipLabel.title || chipLabel.title.length < 10) {
    await browser.close();
    fail(`value=${value}: chip tooltip missing or too short: ${JSON.stringify(chipLabel.title)}`);
  }
  console.log(`  ${value}: chip="${chipLabel.text}" tooltip OK`);

  // Also open the dropdown and verify the corresponding item's secondary
  // copy is present (no friendlier relabelling).
  // Click the chip to open the menu.
  const bar = page.locator('div.h-6.px-4');
  await bar.locator('button').last().click();
  // Menu is in a portal — wait for any item bearing the primary text.
  const item = page.getByRole('menuitem', { name: new RegExp(`^${primary}`, 'i') }).first();
  await item.waitFor({ state: 'visible', timeout: 5000 });
  const itemText = (await item.textContent()) ?? '';
  if (!secondary.test(itemText)) {
    await browser.close();
    fail(`value=${value}: menu item secondary copy mismatch. full itemText=${JSON.stringify(itemText)}, expected to match ${secondary}`);
  }
  console.log(`    menu item secondary OK: ${JSON.stringify(itemText.replace(primary, '').trim())}`);
  // Close the menu by pressing Escape so the next iteration starts clean.
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
}

// Verify the `bypassPermissions` chip gets the warn accent class.
await page.evaluate(() => {
  window.__ccsmStore.getState().setPermission('bypassPermissions');
});
await page.waitForTimeout(80);
const warnClassFound = await page.evaluate(() => {
  const bar = document.querySelector('div.h-6.px-4');
  if (!bar) return false;
  const btns = bar.querySelectorAll('button');
  const last = btns[btns.length - 1];
  return !!last && last.className.includes('state-warning');
});
if (!warnClassFound) {
  await browser.close();
  fail('expected `bypassPermissions` chip to wear the warn accent (text-state-warning class)');
}
console.log('  bypassPermissions chip wears the warn accent OK');

// Confirm no UI references to the retired literals `standard` / `yolo` / `ask`
// leak through. Scan the status bar + any open menus.
await page.evaluate(() => window.__ccsmStore.getState().setPermission('default'));
await page.waitForTimeout(80);
// Open the menu one last time to scan all four items at once.
await page.locator('div.h-6.px-4 button').last().click();
await page.waitForTimeout(150);
const leaked = await page.evaluate(() => {
  const text = document.body.innerText;
  const offenders = [];
  for (const bad of [/\byolo\b/i, /\bstandard\b/i, /\bask-all\b/i]) {
    const m = text.match(bad);
    if (m) offenders.push(m[0]);
  }
  return offenders;
});
if (leaked.length > 0) {
  await browser.close();
  fail(`found retired permission wording in UI: ${leaked.join(', ')}`);
}
await page.keyboard.press('Escape');
console.log('  no retired literals (yolo/standard/ask-all) present OK');

// Screenshot the status bar in its default permission state for visual review.
await page.screenshot({ path: 'scripts/_permission-mode-chip.png', fullPage: false });
console.log('screenshot saved to scripts/_permission-mode-chip.png');

if (errors.length > 0) {
  console.error('--- console / page errors ---');
  for (const e of errors) console.error(e);
}

console.log('\n[probe-permission-mode-chip] OK');
await browser.close();
