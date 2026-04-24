// MERGED INTO scripts/harness-agent.mjs (case id=chat-copy; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Regression: with Menu.setApplicationMenu(null) the Edit-role accelerators
// (Ctrl+A, Ctrl+C, Ctrl+X, Ctrl+V, Ctrl+Z) are not registered on Windows
// and Linux, making chat content feel "not copyable". Verify that Ctrl+A
// actually selects all text in the chat container.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-chat-copy] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(1500);
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

// NOTE: Playwright's keyboard.press dispatches events via CDP, which bypasses
// Electron's application-menu accelerator system. So the Ctrl+A / Ctrl+C path
// below proves that chat text is DOM-selectable and copiable via the clipboard
// API — it does NOT prove that the Edit-role accelerators are wired. The
// accelerator wiring lives in electron/main.ts and must be verified manually
// (or via main-process assertions, not renderer-driven ones).
const SAMPLE = 'COPY_ME_PROBE_TEXT this should land in the clipboard';

await win.evaluate((sample) => {
  window.__ccsmStore.setState({
    groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 's1', name: 's', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
    activeId: 's1',
    messagesBySession: {
      s1: [{ kind: 'assistant', id: 'a1', text: sample }]
    }
  });
}, SAMPLE);
await win.waitForTimeout(300);

// Click into the chat area so focus is on the renderer (not sidebar).
const target = win.getByText('COPY_ME_PROBE_TEXT', { exact: false }).first();
await target.waitFor({ state: 'visible', timeout: 3000 });
await target.click();

// Ctrl+A via the app's accelerator path — this is what real users hit.
await win.keyboard.press('Control+a');
await win.waitForTimeout(100);

const sel = await win.evaluate(() => window.getSelection()?.toString() ?? '');
if (!sel.includes('COPY_ME_PROBE_TEXT')) {
  await app.close();
  fail(`Ctrl+A did not select chat text (selection=${JSON.stringify(sel.slice(0, 80))})`);
}

// Ctrl+C via accelerator.
await win.keyboard.press('Control+c');
await win.waitForTimeout(150);
const clip = await win.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR:${e.message}`));
if (!clip.includes('COPY_ME_PROBE_TEXT')) {
  await app.close();
  fail(`clipboard missing sample after Ctrl+C (clip=${JSON.stringify(clip.slice(0, 80))})`);
}

console.log('\n[probe-e2e-chat-copy] OK');
console.log('  Ctrl+A selects chat, Ctrl+C copies to clipboard');
await app.close();
