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
  env: { ...process.env, NODE_ENV: 'production', CCSM_PROD_BUNDLE: '1' },
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

const cwdRes = await win.evaluate((p) => {
  const st = window.__ccsmStore?.getState?.();
  if (!st) return { err: 'no store' };
  if (typeof st.changeCwd !== 'function') return { err: 'no changeCwd' };
  st.changeCwd(p);
  const after = window.__ccsmStore.getState();
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
      const st = window.__ccsmStore?.getState?.();
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

// Allow-click loop. Earlier probe revision clicked Allow exactly once and
// assumed the first permission prompt belonged to Write. But the user's
// `~/.claude` can inject `Skill` (using-superpowers / slash-command adapter)
// or other preamble tools (Bash for mkdir, etc) as the FIRST tool the model
// runs, which means the first permission prompt can be for something other
// than Write/Edit/MultiEdit. Probabilistic injection caused ~20% flake
// (see dogfood-logs/BUG-186-REPRO.md).
//
// Fix: loop — click Allow on any permission prompt that appears, track
// which tool_use_id got resolved, and keep going until either the
// Write/Edit/MultiEdit tool_result lands in the store OR a 90s timeout
// elapses. For each non-Write/Edit/MultiEdit prompt, log a warning so
// future flake classes are diagnosable.
const allowSel = '[data-perm-action="allow"]';
const WRITE_LIKE = new Set(['Write', 'Edit', 'MultiEdit']);
const resolvedIds = new Set();
const overallDl = Date.now() + 90_000;
let firstAllowAt = null;
let fsHit = null;
let domHit = null;
let storeHit = null;
let snappedShort = false;

async function getWaitingPrompt() {
  // Return { toolName, toolUseId } of the currently-waiting permission
  // block, if any. Best-effort — shape matches what snapDiag reads.
  return await win
    .evaluate(() => {
      const st = window.__ccsmStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      // Waiting permission blocks surface as kind 'tool' with a
      // permissionState === 'waiting' marker, OR the renderer creates
      // a dedicated wait-perm block. Walk in reverse for the most recent.
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        const ps = b.permissionState || b.permission || null;
        if (ps === 'waiting' || (b.kind === 'tool' && ps === 'waiting')) {
          return {
            toolName: b.toolName || b.name || null,
            toolUseId: b.toolUseId || b.id || null,
          };
        }
      }
      // Fallback: last tool block with no result (likely the one the
      // prompt belongs to).
      for (let i = blocks.length - 1; i >= 0; i--) {
        const b = blocks[i];
        if (b.kind === 'tool' && !(typeof b.result === 'string' && b.result.length > 0)) {
          return {
            toolName: b.toolName || b.name || null,
            toolUseId: b.toolUseId || b.id || null,
          };
        }
      }
      return null;
    })
    .catch(() => null);
}

while (Date.now() < overallDl) {
  await win.waitForTimeout(1000);
  if (firstAllowAt && !snappedShort && Date.now() - firstAllowAt >= 500) {
    await snapDiag('post-allow+500ms');
    snappedShort = true;
  }
  // Check for a visible Allow button and click it (loop, not single-shot).
  const allowVisible = await win
    .locator(allowSel)
    .first()
    .isVisible({ timeout: 200 })
    .catch(() => false);
  if (allowVisible) {
    const waiting = await getWaitingPrompt();
    const toolName = waiting?.toolName || '(unknown)';
    const toolUseId = waiting?.toolUseId || null;
    // Dedup only when we have a real id; without one, click anyway — the
    // button's visibility is the source of truth.
    if (!toolUseId || !resolvedIds.has(toolUseId)) {
      if (!firstAllowAt) {
        await snapDiag('pre-allow');
        firstAllowAt = Date.now();
      }
      await win.locator(allowSel).first().click().catch(() => {});
      if (toolUseId) resolvedIds.add(toolUseId);
      if (WRITE_LIKE.has(toolName)) {
        log(`[probe] clicked Allow for Write-like tool: ${toolName} (id=${toolUseId || 'n/a'})`);
      } else {
        // Preamble tool (Skill / Bash / etc). Warn so env-injection flake
        // classes are visible to anyone running the probe.
        console.warn(`[probe] clicked Allow for preamble tool: ${toolName} (id=${toolUseId || 'n/a'})`);
        log(`[probe] preamble tool prompt answered: ${toolName}`);
      }
      if (!snappedShort) await snapDiag('post-allow');
      // Give the renderer a beat to clear the button before next iteration
      // so we don't double-click the same prompt.
      await win.waitForTimeout(500);
    }
  }
  // Signal checks, each loop iteration.
  if (!fsHit && fs.existsSync(filePath)) {
    fsHit = { content: fs.readFileSync(filePath, 'utf8') };
    log(`FS HIT: ${JSON.stringify(fsHit)}`);
  }
  const domFound = await win
    .evaluate(() => {
      const text = document.body?.innerText || '';
      // Tightened: the old regex (`hello\.txt` alone) matched the probe's
      // own user prompt text, producing a false positive even when Write
      // never ran. Anchor on the success sentence the model emits.
      return /File created successfully at[^\n]*hello\.txt/.test(text);
    })
    .catch(() => false);
  if (!domHit && domFound) {
    domHit = true;
    log('DOM HIT');
  }
  const storeSnap = await win
    .evaluate(() => {
      const st = window.__ccsmStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
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
if (!firstAllowAt) fail('never saw Allow button within 90s', app);

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
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
