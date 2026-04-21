// E2E: image drag-drop + paste attachment flow. Covers the UI contract —
// drops a synthesized PNG into the window, pastes another one, asserts chips
// appear, removes one via the × button, then sends the turn and asserts the
// user block in the chat stream carries a rendered <img>. No network is
// required: we intercept window.agentory.agentSendContent in the renderer so
// we can assert the shape of the content-block array without depending on a
// live claude.exe + key.
//
// Run: `AGENTORY_DEV_PORT=4186 npm run dev` in one terminal, then:
// `node scripts/probe-image-attachment.mjs`
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-image-attachment] FAIL: ${msg}`);
  process.exit(1);
}

// Smallest valid PNG: 1x1 red pixel. 67 bytes, pre-encoded as base64 so the
// renderer can dispatch a File(Blob) built from it without touching disk.
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', AGENTORY_DEV_PORT: '4186' }
});

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Stub the native folder-picker so New Session + cwd Browse don't pop a dialog.
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

// Intercept agent IPC in the MAIN process so we can observe the payload the
// renderer sent without depending on a live claude.exe + key. contextBridge
// freezes window.agentory so we can't monkey-patch on the renderer side.
await app.evaluate(async ({ ipcMain, webContents }) => {
  // Remove the live handlers and reinstall stubs.
  ipcMain.removeHandler('agent:start');
  ipcMain.removeHandler('agent:send');
  ipcMain.removeHandler('agent:sendContent');
  globalThis.__probeCaptured = { content: null, text: null };
  ipcMain.handle('agent:start', async () => ({ ok: true }));
  ipcMain.handle('agent:send', async (_e, _sid, text) => {
    globalThis.__probeCaptured.text = text;
    return true;
  });
  ipcMain.handle('agent:sendContent', async (_e, _sid, content) => {
    globalThis.__probeCaptured.content = content;
    // Mirror into the renderer via an arbitrary webContents notify. Easier:
    // just stash on globalThis; the probe reads it via app.evaluate.
    return true;
  });
  // Silence the unused-var lint for webContents.
  void webContents;
});

// 1) New session → textarea visible
const newBtn = win.getByRole('button', { name: /new session/i }).first();
await newBtn.waitFor({ state: 'visible', timeout: 15_000 }).catch(() => fail('no New Session button'));
await newBtn.click();

const textarea = win.locator('textarea');
await textarea.waitFor({ state: 'visible', timeout: 5000 });

// 2) Drag a synthesized PNG file onto the window.
await win.evaluate(async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'dropped.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  // Simulate the full drag sequence so the overlay + intake path both run.
  window.dispatchEvent(new DragEvent('dragenter', { bubbles: true, dataTransfer: dt }));
  window.dispatchEvent(new DragEvent('dragover', { bubbles: true, dataTransfer: dt }));
  window.dispatchEvent(new DragEvent('drop', { bubbles: true, dataTransfer: dt }));
}, PNG_1X1_BASE64);

// Chip shows filename.
const chip1 = win.getByText('dropped.png').first();
await chip1.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('drag chip missing'));

// 3) Paste a clipboard PNG into the textarea.
await textarea.focus();
await win.evaluate(async (b64) => {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const file = new File([bytes], 'pasted.png', { type: 'image/png' });
  const dt = new DataTransfer();
  dt.items.add(file);
  const ta = document.querySelector('textarea');
  if (!ta) throw new Error('textarea gone');
  const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
  ta.dispatchEvent(ev);
}, PNG_1X1_BASE64);

const chip2 = win.getByText('pasted.png').first();
await chip2.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('paste chip missing'));

// 4) Remove the first chip via its × button.
const removeDropped = win.getByRole('button', { name: /remove dropped\.png/i }).first();
await removeDropped.click();
await chip1.waitFor({ state: 'hidden', timeout: 2000 }).catch(() => fail('dropped.png chip did not disappear after remove'));

// 5) Type text and send.
await textarea.fill('what is in this image?');
await win.keyboard.press('Enter');

// 6) Assert the CAPTURED content-blocks carry an image block + the text.
const captured = await app.evaluate(() => globalThis.__probeCaptured);
if (!captured.content || !Array.isArray(captured.content)) {
  // Dump DOM + captured state to help debug.
  const dump = await win.evaluate(() => ({
    chips: Array.from(document.querySelectorAll('img')).map((i) => i.alt || i.src.slice(0, 40)),
    bodyText: document.body.innerText.slice(0, 800)
  }));
  console.error('--- probe dump ---\n' + JSON.stringify({ ...dump, captured }, null, 2));
  console.error('--- page errors ---\n' + errors.slice(-10).join('\n'));
  fail('agentSendContent was never called with a content-block array');
}
const hasImage = captured.content.some(
  (b) => b && b.type === 'image' && b.source && b.source.type === 'base64' && b.source.media_type === 'image/png'
);
const hasText = captured.content.some(
  (b) => b && b.type === 'text' && typeof b.text === 'string' && b.text.includes('what is in this image')
);
if (!hasImage) fail(`missing image block; got ${JSON.stringify(captured.content).slice(0, 300)}`);
if (!hasText) fail(`missing text block; got ${JSON.stringify(captured.content).slice(0, 300)}`);

// 7) Assert the user block in chat shows a thumbnail <img> with the data URL.
const userImg = win.locator('img[alt="pasted.png"]').first();
await userImg.waitFor({ state: 'visible', timeout: 3000 }).catch(() => fail('user message thumbnail not rendered'));

console.log(`\n[probe-image-attachment] OK`);
console.log(`  drag chip:    visible → removed`);
console.log(`  paste chip:   visible`);
console.log(`  content blocks: ${captured.content.length} (image + text)`);
console.log(`  user thumbnail: rendered`);

await app.close();
