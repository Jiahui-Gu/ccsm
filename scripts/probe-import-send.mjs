import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await app.firstWindow();
const logs = [];
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// 1) Open Import dialog from empty-state OR command palette.
const empty = await win.locator('text=Import from Claude Code').first();
const visible = await empty.isVisible().catch(() => false);
console.log('[probe] empty-state import button visible:', visible);

if (visible) {
  await empty.click();
} else {
  await win.keyboard.press('Control+K');
  await win.waitForTimeout(300);
  await win.keyboard.type('Import');
  await win.waitForTimeout(200);
  await win.keyboard.press('Enter');
}

await win.waitForTimeout(1500);

// 2) Read the dialog content.
const dialogSnapshot = await win.evaluate(() => {
  const dlg = document.querySelector('[role="dialog"]');
  return dlg ? dlg.outerHTML.slice(0, 4000) : '<NO DIALOG>';
});
console.log('--- import dialog (4000 chars) ---');
console.log(dialogSnapshot);

// 3) Pick first checkbox row and click Import.
const rowCount = await win.locator('[role="dialog"] input[type="checkbox"]').count();
console.log('[probe] checkbox count in dialog:', rowCount);

if (rowCount > 1) {
  // index 0 might be a select-all; pick index 1 (first item)
  await win.locator('[role="dialog"] input[type="checkbox"]').nth(1).click();
  await win.waitForTimeout(200);
}

// Click the Import action button.
const importBtn = win.locator('[role="dialog"] button', { hasText: /^Import/ }).last();
const importBtnExists = await importBtn.count();
console.log('[probe] import action button count:', importBtnExists);
if (importBtnExists) {
  await importBtn.click();
}

await win.waitForTimeout(1500);

// 4) Inspect store after import.
const storeAfter = await win.evaluate(() => {
  const s = window.__agentoryStore?.getState?.();
  if (!s) return 'NO STORE';
  return {
    sessionCount: s.sessions.length,
    activeId: s.activeId,
    active: s.sessions.find((x) => x.id === s.activeId),
    groups: s.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind }))
  };
});
console.log('--- store after import ---');
console.log(JSON.stringify(storeAfter, null, 2));

// 5) Send a message in the imported session.
const textarea = win.locator('textarea').first();
await textarea.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
await textarea.click();
await textarea.fill('hello from e2e probe');
await win.waitForTimeout(200);
await win.keyboard.press('Enter');

await win.waitForTimeout(8000);

// 6) Inspect post-send state + last error/blocks.
const sendResult = await win.evaluate(() => {
  const s = window.__agentoryStore?.getState?.();
  if (!s) return 'NO STORE';
  const active = s.sessions.find((x) => x.id === s.activeId);
  return {
    activeId: s.activeId,
    active,
    started: s.startedSessions[s.activeId],
    running: s.runningSessions[s.activeId],
    blockCount: (s.messagesBySession[s.activeId] ?? []).length,
    lastBlocks: (s.messagesBySession[s.activeId] ?? []).slice(-6)
  };
});
console.log('--- post-send state ---');
console.log(JSON.stringify(sendResult, null, 2));

console.log('--- console logs ---');
for (const l of logs.slice(-60)) console.log(l);

await app.close();
