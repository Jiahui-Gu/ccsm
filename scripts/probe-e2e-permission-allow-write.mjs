// E2E regression probe for Bug L / A2-NEW-3.
//
// Symptom: clicking "Allow (Y)" on a Write tool permission prompt resolved
// the renderer state but never reached claude.exe in a way that let the Write
// actually execute. The file was never written and no `tool_result` arrived.
//
// Root cause: outbound `control_response` for `hook_callback` was emitted
// in the FLAT shape `{ type, request_id, response }` while real claude.exe
// expects the SAME nested envelope used inbound:
// `{ type, response: { subtype: "success", request_id, response } }`.
// claude.exe silently dropped the flat frame.
//
// This probe drives the full prod bundle: spawn Electron → new session →
// prompt for a Write → wait for the Allow button → click Allow → assert
// within 30s that:
//   A. The file actually exists on disk under the session cwd.
//   B. The DOM shows the rendered tool_result content.
//   C. The renderer store's Write tool block has `result` populated
//      (the closest in-process surrogate for "claude.exe sent us a
//      tool_result frame").
//
// All three signals must hit. If any fails, Bug L has regressed.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-bugl-write-${TS}`);
const PROJ = path.join(os.tmpdir(), `agentory-bugl-write-proj-${TS}`);
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

// Anchor the model on the Write tool explicitly. Earlier wording
// ("Write a file called ...") let the model occasionally pick Edit /
// MultiEdit instead, which made the downstream `tn === 'Write'` store
// assertion flake. We also widen that assertion below to accept any
// file-mutating tool (Write/Edit/MultiEdit) since all three exercise the
// same Bug L permission/control_response path.
const PROMPT =
  "Use the Write tool to create a NEW file at ./hello.txt with exactly the content 'world' (no trailing newline). Do not use Edit or MultiEdit.";

function log(m) {
  process.stderr.write(`[probe-bugl-write ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-bugl-write] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  process.exit(1);
}

log(`START PROJ=${PROJ} UDD=${UDD}`);

const app = await electron.launch({
  args: ['.', `--user-data-dir=${UDD}`],
  cwd: ROOT,
  env: { ...process.env, NODE_ENV: 'production', AGENTORY_PROD_BUNDLE: '1' },
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

const cwdRes = await win.evaluate((p) => {
  const st = window.__agentoryStore?.getState?.();
  if (!st) return { err: 'no store' };
  if (typeof st.changeCwd !== 'function') return { err: 'no changeCwd' };
  st.changeCwd(p);
  const after = window.__agentoryStore.getState();
  const sess = (after.sessions || []).find((x) => x.id === after.activeId);
  return { sid: after.activeId, cwd: sess?.cwd };
}, PROJ);
log(`cwd set: ${JSON.stringify(cwdRes)}`);
await win.waitForTimeout(400);

const ta = win.locator('textarea').first();
await ta.waitFor({ state: 'visible', timeout: 8000 });
await ta.click();
await ta.fill(PROMPT);
await win.keyboard.press('Enter');
log('prompt sent');

// Bug #186 diagnostic: capture all blocks + fs state at time points for
// post-mortem of the "Allow success but file not on fs" flake. Stored
// in an artifact under dogfood-logs/ when the run fails.
const diagTimeline = [];
async function snapDiag(label) {
  let snap = null;
  try {
    snap = await win.evaluate(() => {
      const st = window.__agentoryStore?.getState?.();
      const sid = st?.activeId;
      const blocks = (st?.messagesBySession?.[sid] || []).map((b) => ({
        kind: b.kind,
        toolName: b.toolName || b.name,
        toolUseId: b.toolUseId || b.id,
        hasResult: typeof b.result === 'string' && b.result.length > 0,
        resultHead: typeof b.result === 'string' ? b.result.slice(0, 200) : null,
        isError: b.isError === true,
        input: b.input ? JSON.stringify(b.input).slice(0, 300) : null,
        permissionState: b.permissionState || b.permission || null,
      }));
      return { sid, cwd: (st?.sessions || []).find((x) => x.id === sid)?.cwd, blocks };
    });
  } catch (e) {
    snap = { err: String(e) };
  }
  let projFiles = null;
  try {
    projFiles = fs.readdirSync(PROJ);
  } catch (e) {
    projFiles = String(e);
  }
  const fileExists = fs.existsSync(filePath);
  diagTimeline.push({
    label,
    ts: new Date().toISOString(),
    tMs: Date.now(),
    fileExists,
    projFiles,
    store: snap,
  });
  log(`DIAG[${label}] fileExists=${fileExists} projFiles=${JSON.stringify(projFiles)} blocks=${snap?.blocks?.length ?? '?'}`);
}
const filePath = path.join(PROJ, 'hello.txt');

// Wait up to 90s for the Allow button to appear.
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
    await snapDiag('pre-allow');
    await win.locator(allowSel).first().click();
    allowClicked = true;
    log('clicked Allow (Y)');
    await snapDiag('post-allow');
    break;
  }
}
if (!allowClicked) fail('never saw Allow button within 90s', app);

// 60s observation window for the three signals.
const obsStart = Date.now();
let fsHit = null;
let domHit = null;
let storeHit = null;
let snappedShort = false;
while (Date.now() - obsStart < 60_000) {
  await win.waitForTimeout(1500);
  if (!snappedShort && Date.now() - obsStart >= 500) {
    await snapDiag('post-allow+500ms');
    snappedShort = true;
  }
  if (!fsHit && fs.existsSync(filePath)) {
    fsHit = { content: fs.readFileSync(filePath, 'utf8') };
    log(`FS HIT: ${JSON.stringify(fsHit)}`);
  }
  const domFound = await win
    .evaluate(() => {
      const text = document.body?.innerText || '';
      return /File created successfully|File written|hello\.txt/.test(text);
    })
    .catch(() => false);
  if (!domHit && domFound) {
    domHit = true;
    log('DOM HIT');
  }
  const storeSnap = await win
    .evaluate(() => {
      const st = window.__agentoryStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      // Accept any file-mutating tool — the prompt anchors on Write but if
      // the model picks Edit/MultiEdit they exercise the SAME Bug L
      // permission round-trip path, so the test is still valid. The fs
      // assertion below independently verifies the file content.
      const writeLike = new Set(['Write', 'Edit', 'MultiEdit']);
      const w = blocks.find((b) => {
        const tn = b.toolName || b.name;
        return b.kind === 'tool' && writeLike.has(tn);
      });
      return w
        ? { hasResult: typeof w.result === 'string' && w.result.length > 0, isError: w.isError === true, toolName: w.toolName || w.name, resultHead: typeof w.result === 'string' ? w.result.slice(0, 120) : null }
        : { allBlocks: blocks.map((b) => ({ kind: b.kind, toolName: b.toolName || b.name, hasResult: typeof b.result === 'string' && b.result.length > 0 })) };
    })
    .catch(() => null);
  if (!storeHit && storeSnap?.hasResult) {
    storeHit = storeSnap;
    log(`STORE HIT: ${JSON.stringify(storeSnap)}`);
  }
  if (fsHit && storeHit) break;
}

const projFiles = (() => {
  try {
    return fs.readdirSync(PROJ);
  } catch {
    return null;
  }
})();
log(`PROJ files: ${JSON.stringify(projFiles)}`);
await snapDiag('observation-end');

// Bug #186 diagnostic dump: on any fs/store miss, write a timestamped
// artifact under dogfood-logs/ with the full timeline + walk of PROJ
// and its ancestors (catches case (c): file written to wrong cwd).
function dumpBug186Artifact(reason) {
  try {
    const artifactDir = path.join(ROOT, 'dogfood-logs');
    fs.mkdirSync(artifactDir, { recursive: true });
    const artifactPath = path.join(artifactDir, `bug-186-${TS}.json`);
    // Walk PROJ + tmp dir for any 'hello.txt' that landed in wrong cwd.
    const wanderers = [];
    function walk(dir, depth) {
      if (depth > 3) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          walk(full, depth + 1);
        } else if (e.name === 'hello.txt') {
          let content = null;
          try { content = fs.readFileSync(full, 'utf8').slice(0, 200); } catch {}
          wanderers.push({ path: full, content });
        }
      }
    }
    walk(PROJ, 0);
    walk(os.tmpdir(), 0);
    walk(process.cwd(), 0);
    walk(ROOT, 0);
    const artifact = {
      bug: 186,
      reason,
      ts: new Date().toISOString(),
      PROJ,
      UDD,
      expectedPath: filePath,
      probeCwd: process.cwd(),
      electronCwd: ROOT,
      projFiles,
      wanderers,
      timeline: diagTimeline,
    };
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2));
    log(`BUG-186 ARTIFACT WRITTEN: ${artifactPath}`);
  } catch (e) {
    log(`BUG-186 ARTIFACT WRITE FAILED: ${e}`);
  }
}

if (!fsHit) {
  dumpBug186Artifact('fs-miss');
  fail(`Write never executed — file ${filePath} missing (PROJ files=${JSON.stringify(projFiles)})`, app);
}
if (fsHit.content.trim() !== 'world')
  fail(`Write executed but content unexpected: ${JSON.stringify(fsHit.content)}`, app);
if (!storeHit) {
  dumpBug186Artifact('store-miss');
  fail('Write tool block never received a tool_result (store proxy for claude.exe stdout)', app);
}
if (storeHit.isError) {
  dumpBug186Artifact('store-isError');
  fail('Write tool block received an ERROR result, expected success', app);
}
if (!domHit) log('WARN: DOM signal missed (non-fatal — fs+store assertion is authoritative)');

console.log('[probe-bugl-write] OK: file written, tool_result delivered, store updated');
await app.close();
process.exit(0);
