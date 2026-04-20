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
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Create a fresh session via store action (skip cwd picker dialog).
await win.evaluate(() => {
  window.__agentoryStore.getState().createSession('C:\\Users\\jiahuigu\\projects\\agentory-next');
});
await win.waitForTimeout(800);

const textarea = win.locator('textarea').first();
await textarea.click();
await textarea.fill('hi from new-session probe');
await win.keyboard.press('Enter');
await win.waitForTimeout(7000);

const out = await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  return {
    activeId: s.activeId,
    blocks: (s.messagesBySession[s.activeId] ?? []).slice(-4)
  };
});
console.log(JSON.stringify(out, null, 2));
await app.close();
