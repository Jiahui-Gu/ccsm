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
//
// PreToolUse hook restored (#94 fix, post PR #271 SDK migration)
// ──────────────────────────────────────────────────────────────
// The Claude Code CLI's local rule engine handles built-in `Bash` tool
// invocations entirely client-side; in default mode it will auto-allow many
// Bash calls based on its safe-command heuristics and never consult
// `canUseTool` (the SDK callback ccsm hooks into). To force every tool
// invocation through ccsm's permission flow, the runner registers a
// `PreToolUse` SDK hook (`options.hooks.PreToolUse`, matcher `.*`,
// `permissionDecision: 'ask'`) — see electron/agent-sdk/sessions.ts. With
// that hook the CLI defers Bash to canUseTool deterministically, the
// renderer alertdialog renders, and Allow → tool_result is the strict
// assertion below.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedClaudeConfigDir } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-bugl-bash-${TS}`);
const PROJ = path.join(os.tmpdir(), `agentory-bugl-bash-proj-${TS}`);
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

// Sandbox CLAUDE_CONFIG_DIR so the dev's real `~/.claude/settings.json`
// (which may have `Bash(*)` allowlisted) cannot auto-allow the bash command
// before the permission prompt fires. Without this, a permissive dev config
// turns this probe into a silent no-op false-green.
const cfg = isolatedClaudeConfigDir('agentory-bugl-bash');

// Use a bash command unlikely to be in any default allowlist so the host
// permission prompt definitely fires. `node --version` is harmless and
// universally available (this IS a Node project — node is required to
// build/run ccsm), while `Bash(node:*)` is NOT in the upstream CLI's
// default-allow list, so the permission prompt still fires. Avoids the
// silent system-Python dependency the previous fixture had.
const PROMPT =
  'Run the bash command `node --version` and tell me the version number.';

function log(m) {
  process.stderr.write(`[probe-bugl-bash ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-bugl-bash] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  cfg.cleanup();
  process.exit(1);
}

log(`START PROJ=${PROJ} UDD=${UDD}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${UDD}`],
  cwd: ROOT,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    CCSM_CLAUDE_CONFIG_DIR: cfg.dir,
  },
});

try { // ccsm-probe-cleanup-wrap
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

// With the PreToolUse hook (#94) installed in the SDK runner, the Allow
// button MUST appear and a click MUST land before the tool_result arrives.
const allowSel = '[data-perm-action="allow"]';
const waitDl = Date.now() + 90_000;
let allowClicked = false;
let storeHit = null;
while (Date.now() < waitDl) {
  await win.waitForTimeout(1000);
  // Strict path — click Allow if rendered.
  if (!allowClicked) {
    const visible = await win
      .locator(allowSel)
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (visible) {
      await win.locator(allowSel).first().click();
      allowClicked = true;
      log('clicked Allow (Y)');
    }
  }
  // Always poll for the result regardless of prompt.
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
  if (snap?.hasResult) {
    storeHit = snap;
    log(`STORE HIT: ${JSON.stringify(snap)}`);
    break;
  }
}

if (!storeHit) {
  fail('Bash tool block never received a tool_result (Bug L regression OR CLI did not run the tool at all)', app);
}
if (storeHit.isError)
  fail(`Bash tool block received an ERROR result: ${storeHit.head}`, app);

if (!allowClicked) {
  fail('Allow button never rendered — PreToolUse hook (#94) regression? CLI auto-allowed Bash without firing canUseTool.', app);
}

console.log('[probe-bugl-bash] OK: Allow clicked, bash executed, tool_result delivered');
await app.close();
cfg.cleanup();
process.exit(0);
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
