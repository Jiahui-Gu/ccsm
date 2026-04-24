// Visual capture probe for #306 — snapshots the PermissionPromptBlock for a
// 3-hunk MultiEdit so the PR body can show before/after side-by-side. Not a
// pass/fail probe; just emits PNGs to dogfood-logs/perm-block-partial-306/.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs/perm-block-partial-306');
fs.mkdirSync(outDir, { recursive: true });

const variant = process.argv.find((a) => a.startsWith('--variant='))?.slice('--variant='.length) ?? 'after';
const filename = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? `${variant}.png`;

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'production', CCSM_PROD_BUNDLE: '1' }
});

const win = await appWindow(app, { timeout: 30_000 });
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
await win.waitForTimeout(500);

await win.evaluate(() => {
  window.__ccsmStore?.setState({
    cliStatus: { state: 'found', binaryPath: '<harness>', version: null },
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's-shot', name: 'shot', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: 's-shot',
    messagesBySession: { 's-shot': [] }
  });
});
await win.waitForTimeout(300);

await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-SHOT',
    prompt: 'MultiEdit /tmp/example.ts (3 edits)',
    intent: 'permission',
    requestId: 'SHOT',
    toolName: 'MultiEdit',
    toolInput: {
      file_path: '/tmp/example.ts',
      edits: [
        { old_string: 'const greeting = "hi"', new_string: 'const greeting = "hello, world"' },
        { old_string: 'function add(a, b) { return a+b; }', new_string: 'function add(a: number, b: number): number {\n  return a + b;\n}' },
        { old_string: 'export default add;', new_string: 'export { add };\nexport default add;' }
      ]
    }
  }]);
});

const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5_000 });
await win.waitForTimeout(400);

// Optional: deselect a hunk before shooting to show the dimmed-overlay state.
if (variant === 'after-partial') {
  await win.evaluate(() => {
    const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
    boxes[1]?.click();
  });
  await win.waitForTimeout(300);
}

const container = await win.locator('[role="alertdialog"]').first();
const out = path.join(outDir, filename);
await container.screenshot({ path: out });
console.log(`[shot] wrote ${out} (variant=${variant})`);

await app.close();
