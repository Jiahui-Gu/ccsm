// E2E regression probe for Bug L / A2-NEW-3 (Bash variant).
//
// Same root cause as probe-e2e-permission-allow-write.mjs but exercises a
// Bash invocation that triggers the host permission prompt (NOT one auto-
// allowed by the settings allowlist — that path bypasses the permission
// callback entirely and won't catch the bug).
//
// Pre-fix: clicking Allow on the Bash prompt resolved the renderer state
// but the bash never executed and no tool_result arrived. Post-fix the
// nested control_response envelope reaches claude.exe and the bash runs.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-bugl-bash-${TS}`);
const PROJ = path.join(os.tmpdir(), `agentory-bugl-bash-proj-${TS}`);
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

// Use a bash command unlikely to be in any default allowlist so the host
// permission prompt definitely fires. `python --version` is harmless but
// prompts unless `Bash(python:*)` is explicitly allowed in user settings.
const PROMPT =
  "Run the bash command `python --version` (or `python3 --version` if python is not found) and tell me the version number.";

function log(m) {
  process.stderr.write(`[probe-bugl-bash ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-bugl-bash] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

log(`START PROJ=${PROJ} UDD=${UDD}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${UDD}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', CCSM_PROD_BUNDLE: '1' },
});
app.process().stderr?.on('data', (d) => process.stderr.write(`[electron-stderr] ${d}`));

let win;
const winDl = Date.now() + 30_000;
while (Date.now() < winDl) {
  for (const w of app.windows()) {
    const u = w.url();
    if (u.startsWith('http') || u.startsWith('file')) {
      win = w;
      break;
    }
  }
  if (win) break;
  await new Promise((r) => setTimeout(r, 200));
}
if (!win) fail('no Electron window appeared in 30s', app);
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

await win.getByRole('button', { name: /new session/i }).first().click();
await win.waitForTimeout(1000);
log('clicked New Session');

await win.evaluate((p) => {
  const st = window.__ccsmStore?.getState?.();
  if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
}, PROJ);
await win.waitForTimeout(400);

const ta = win.locator('textarea').first();
await ta.waitFor({ state: 'visible', timeout: 8000 });
await ta.click();
await ta.fill(PROMPT);
await win.keyboard.press('Enter');
log('prompt sent');

const allowSel = '[data-perm-action="allow"]';
const waitDl = Date.now() + 90_000;
let allowClicked = false;
while (Date.now() < waitDl) {
  await win.waitForTimeout(1000);
  const visible = await win
    .locator(allowSel)
    .first()
    .isVisible({ timeout: 200 })
    .catch(() => false);
  if (visible) {
    await win.locator(allowSel).first().click();
    allowClicked = true;
    log('clicked Allow (Y)');
    break;
  }
}
if (!allowClicked) fail('never saw Allow button within 90s', app);

// 30s observation window. For Bash there is no fs side effect to assert on,
// so we rely on the Bash tool block in the renderer store gaining a result.
const obsStart = Date.now();
let storeHit = null;
while (Date.now() - obsStart < 30_000) {
  await win.waitForTimeout(1500);
  const snap = await win
    .evaluate(() => {
      const st = window.__ccsmStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      const b = blocks.find((x) => {
        const tn = x.toolName || x.name;
        return x.kind === 'tool' && tn === 'Bash';
      });
      return b
        ? {
            hasResult: typeof b.result === 'string' && b.result.length > 0,
            isError: b.isError === true,
            head: typeof b.result === 'string' ? b.result.slice(0, 200) : null,
          }
        : null;
    })
    .catch(() => null);
  if (!storeHit && snap?.hasResult) {
    storeHit = snap;
    log(`STORE HIT: ${JSON.stringify(snap)}`);
    break;
  }
}

if (!storeHit)
  fail('Bash tool block never received a tool_result after Allow (Bug L regression)', app);
if (storeHit.isError)
  fail(`Bash tool block received an ERROR result: ${storeHit.head}`, app);

console.log('[probe-bugl-bash] OK: bash executed, tool_result delivered');
await app.close();
process.exit(0);
