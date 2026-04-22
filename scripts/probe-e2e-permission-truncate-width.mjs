// Journey 3: long toolInput truncation + container width.
//
// Expected user experience: a permission whose toolInput is an 800-char SQL
// statement should render with the SQL truncated (~400 chars + ellipsis) so
// the prompt stays scannable. The permission block container must also stay
// within the chat column width — no horizontal overflow that pushes other UI
// or causes a horizontal scrollbar.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const PROBE = 'probe-e2e-permission-truncate-width';

function fail(msg, app, cleanup) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  if (cleanup) cleanup();
  process.exit(1);
}

const ud = isolatedUserData(PROBE);
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));
await app.evaluate(async ({ dialog }, fakeCwd) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [fakeCwd] });
}, root);

const win = await appWindow(app, { timeout: 30_000 });
win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

const newBtn = win.getByRole('button', { name: /new session/i }).first();
if (await newBtn.isVisible().catch(() => false)) {
  await newBtn.click();
  await win.waitForTimeout(1500);
}

// Build an 800-char SQL string with no spaces around a unique marker so we
// can search for it post-render.
const MARKER = 'ZZUNIQUEMARKERZZ';
const longSql = 'SELECT ' +
  Array.from({ length: 60 }, (_, i) => `col_${i}`).join(', ') +
  ' FROM users WHERE ' +
  Array.from({ length: 30 }, (_, i) => `flag_${i}=1`).join(' AND ') +
  ` -- ${MARKER}`;
const padded = longSql.length < 800
  ? longSql + ' /* ' + 'x'.repeat(800 - longSql.length - 5) + ' */'
  : longSql;

await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  if (!s.activeId) s.createSession?.(null);
});
await win.waitForTimeout(200);

await win.evaluate((sql) => {
  const s = window.__agentoryStore.getState();
  s.appendBlocks(s.activeId, [{
    kind: 'waiting',
    id: 'wait-PROBE-LONG',
    prompt: 'Bash: long sql',
    intent: 'permission',
    requestId: 'PROBE-LONG',
    toolName: 'Bash',
    toolInput: { command: sql, description: 'huge query' }
  }]);
}, padded);

const heading = win.locator('text=Permission required').first();
await heading.waitFor({ state: 'visible', timeout: 5000 }).catch(() => fail('heading not visible', app, ud.cleanup));
await win.waitForTimeout(300);

// Read what got rendered inside the permission container.
const measure = await win.evaluate(({ marker, padded }) => {
  const heading = Array.from(document.querySelectorAll('*')).find(
    (n) => n.textContent?.trim() === 'Permission required'
  );
  const container = heading?.closest('[role="alertdialog"]');
  if (!container) return { ok: false };
  const rect = container.getBoundingClientRect();
  const text = container.textContent ?? '';
  // Find the chat scroll column — typically the closest <main> or scrolling
  // ancestor. Walk up looking for the first ancestor whose offsetWidth is
  // significantly larger than the container's width is fine; instead just
  // measure the body width.
  const body = document.body.getBoundingClientRect();
  return {
    ok: true,
    width: rect.width,
    bodyWidth: body.width,
    overflowsViewport: rect.right > body.right + 1,
    fullSqlLen: padded.length,
    rawTextHasFullSql: text.includes(padded),
    rawTextHasMarker: text.includes(marker),
    hasEllipsis: /[…]|\.{3}/.test(text),
    horizontalScroll: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1
  };
}, { marker: MARKER, padded });

if (!measure.ok) fail('could not locate permission alertdialog container', app, ud.cleanup);
console.log(`[${PROBE}] measure:`, JSON.stringify(measure));

// CONTRACT 1: full 800-char SQL must NOT be present verbatim.
if (measure.rawTextHasFullSql) {
  fail('full 800-char toolInput rendered verbatim — no truncation', app, ud.cleanup);
}
// CONTRACT 2: an ellipsis indicator must be present so user knows it's cut.
if (!measure.hasEllipsis) {
  fail('no ellipsis ("…" or "...") in permission body — truncation not signalled', app, ud.cleanup);
}
// CONTRACT 3: container must not overflow viewport.
if (measure.overflowsViewport) {
  fail(`container right edge ${measure.width} overflows viewport (body ${measure.bodyWidth})`, app, ud.cleanup);
}
// CONTRACT 4: no document-level horizontal scroll caused by this block.
if (measure.horizontalScroll) {
  fail('document developed a horizontal scrollbar after rendering long permission', app, ud.cleanup);
}

console.log(`\n[${PROBE}] OK: long toolInput truncated, container fits viewport`);
await app.close();
ud.cleanup();
