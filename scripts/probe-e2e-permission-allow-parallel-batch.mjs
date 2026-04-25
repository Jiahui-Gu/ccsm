// E2E regression probe for Bug L / A2-NEW-3 — parallel tool batch variant.
//
// Background: when the agent emits N tool_use blocks in a single turn
// (parallel tool batch), the harness must (a) deliver N independent permission
// decisions back to claude.exe, (b) keep N independent tool blocks in the
// renderer store so the N tool_results can be attached. Two distinct
// regressions have been seen:
//
//   1. PR #172 (Bug L): outbound `control_response` envelope shape was wrong
//      so claude.exe silently dropped hook_callback responses. Fixed there;
//      this probe still guards against regression.
//   2. Bug L follow-up (this file's primary subject): even after #172,
//      claude.exe streams parallel tool batches as N SEPARATE assistant
//      events that share `message.id` but each carry a single tool_use in
//      `content[]`. The renderer numbered tool block ids by per-event
//      position (`${msgId}:tu0`), so all N collapsed to one block id and
//      `appendBlocks` coalesced them — N-1 of N tool_results then had no
//      block to attach to. Fix: derive the block id from the globally
//      unique `tool_use.id`. See `assistantBlocks` in
//      `src/agent/stream-to-blocks.ts`.
//
// Two cases below cover both the Bash and Read parallel-batch shapes seen
// in the wild (Bash from the original probe; Read from Dogfood G's
// REPORT-RERUN.md §A2-NEW-3-PARALLEL-V2). Tightened assertion:
// `succeeded.length === clicks` — every Allow click must produce a
// resolved tool_result, not just one.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { isolatedClaudeConfigDir } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-bugl-par-${TS}`);
fs.mkdirSync(UDD, { recursive: true });

// Sandbox CLAUDE_CONFIG_DIR so the dev's real `~/.claude/settings.json`
// can't auto-allow Bash/Read calls before the prompts fire — see
// probe-e2e-permission-allow-bash.mjs for rationale.
const cfg = isolatedClaudeConfigDir('agentory-bugl-par');

function log(m) {
  process.stderr.write(`[probe-bugl-parallel ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-bugl-parallel] FAIL: ${msg}`);
  if (app) app.close().catch(() => {});
  cfg.cleanup();
  process.exit(1);
}

log(`START UDD=${UDD}`);

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

/**
 * Run a single parallel-batch case end-to-end.
 *
 *   - Creates a fresh project dir seeded with `files`.
 *   - Opens a NEW session (so every case starts with an empty store).
 *   - Sends `prompt`.
 *   - Clicks every Allow that appears.
 *   - Polls the store for tool blocks matching `toolName`.
 *   - Asserts `clicks === expectedClicks`, every Allow produced a
 *     permission-resolved trace, AND every tool block ended up with a
 *     non-empty `result` (`succeeded.length === clicks`).
 *
 * Returns the final snapshot for caller logging.
 */
async function runCase({ caseName, files, prompt, toolName, expectedClicks }) {
  log(`--- case: ${caseName} ---`);
  const proj = path.join(os.tmpdir(), `agentory-bugl-par-proj-${caseName}-${TS}`);
  fs.mkdirSync(proj, { recursive: true });
  for (const [i, f] of files.entries()) {
    fs.writeFileSync(path.join(proj, f), `file-${i}-content\n`);
  }

  await win.getByRole('button', { name: /new session/i }).first().click();
  await win.waitForTimeout(1000);

  await win.evaluate((p) => {
    const st = window.__ccsmStore?.getState?.();
    if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
  }, proj);
  await win.waitForTimeout(400);

  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.click();
  await ta.fill(prompt);
  await win.keyboard.press('Enter');
  log(`[${caseName}] prompt sent`);

  const allowSel = '[data-perm-action="allow"]';
  const totalDl = Date.now() + 120_000;
  let lastClickAt = 0;
  let clicks = 0;
  while (Date.now() < totalDl) {
    await win.waitForTimeout(750);
    const visible = await win
      .locator(allowSel)
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (visible) {
      await win.locator(allowSel).first().click();
      clicks += 1;
      lastClickAt = Date.now();
      log(`[${caseName}] clicked Allow #${clicks}`);
      continue;
    }
    if (clicks > 0 && Date.now() - lastClickAt > 8_000) break;
  }
  if (clicks === 0) fail(`[${caseName}] never saw any Allow button within 120s`, app);
  log(`[${caseName}] total Allow clicks: ${clicks}`);

  const obsStart = Date.now();
  let snap;
  while (Date.now() - obsStart < 60_000) {
    await win.waitForTimeout(2000);
    snap = await win
      .evaluate((tn) => {
        const st = window.__ccsmStore?.getState?.();
        const sid = st?.activeId;
        const blocks = st?.messagesBySession?.[sid] || [];
        const tools = blocks
          .filter((b) => {
            const name = b.toolName || b.name;
            return b.kind === 'tool' && name === tn;
          })
          .map((b) => ({
            toolUseId: b.toolUseId,
            id: b.id,
            hasResult: typeof b.result === 'string' && b.result.length > 0,
            isError: b.isError === true,
            resultLen: typeof b.result === 'string' ? b.result.length : 0,
          }));
        const resolvedTraces = blocks.filter(
          (b) =>
            b.kind === 'system' &&
            b.subkind === 'permission-resolved' &&
            (b.decision === 'allowed' || b.decision === 'allow'),
        ).length;
        const allBlockKinds = blocks.map(
          (b) => `${b.kind}:${b.toolName || b.name || ''}:${b.toolUseId || b.id || ''}`,
        );
        return { tools, resolvedTraces, totalBlocks: blocks.length, allBlockKinds };
      }, toolName)
      .catch(() => null);
    if (
      snap &&
      snap.resolvedTraces >= clicks &&
      snap.tools.length >= clicks &&
      snap.tools.filter((t) => t.hasResult).length >= clicks
    )
      break;
  }

  if (!snap) fail(`[${caseName}] could not snapshot store`, app);
  log(`[${caseName}] final snapshot: tools=${JSON.stringify(snap.tools)} resolvedTraces=${snap.resolvedTraces}`);
  log(`[${caseName}] final allBlocks=${JSON.stringify(snap.allBlockKinds)}`);

  if (expectedClicks && clicks !== expectedClicks)
    fail(
      `[${caseName}] expected ${expectedClicks} Allow clicks but observed ${clicks}. Did the model serialize the calls instead of issuing them in parallel?`,
      app,
    );

  if (snap.resolvedTraces < clicks)
    fail(
      `[${caseName}] Bug L renderer regression: clicked Allow ${clicks}x but only ${snap.resolvedTraces} permission-resolved traces appeared in store.`,
      app,
    );

  if (snap.tools.length < clicks)
    fail(
      `[${caseName}] Bug L parallel-batch RENDERER regression: ${clicks} Allow clicks but only ${snap.tools.length} \`tool:${toolName}\` blocks exist in store. ` +
        `Parallel tool_use blocks are being coalesced by id (see assistantBlocks). allBlocks=${JSON.stringify(snap.allBlockKinds)}`,
      app,
    );

  const succeeded = snap.tools.filter((t) => t.hasResult);
  if (succeeded.length !== clicks)
    fail(
      `[${caseName}] Bug L parallel-batch IPC/RENDERER regression: ${clicks} Allow clicks but only ${succeeded.length}/${clicks} \`tool:${toolName}\` blocks received a tool_result. ` +
        `tools=${JSON.stringify(snap.tools)} allBlocks=${JSON.stringify(snap.allBlockKinds)}`,
      app,
    );

  const errored = snap.tools.filter((t) => t.isError);
  if (errored.length > 0)
    fail(`[${caseName}] one or more ${toolName} tool blocks errored: ${JSON.stringify(errored)}`, app);

  log(
    `[${caseName}] OK: ${clicks} Allow clicks → ${snap.resolvedTraces} resolved traces, ${succeeded.length}/${clicks} ${toolName} blocks have tool_result.`,
  );
  return { clicks, snap };
}

// === case: parallel-bash-N4 ===
// Original Bug L probe shape — 4 parallel `cat` Bash calls. Verifies the
// IPC envelope fix from PR #172 still holds AND the renderer-side block-id
// fix correctly creates 4 distinct tool blocks.
const BASH_FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
const BASH_PROMPT =
  `Run these four bash commands IN PARALLEL in a SINGLE message containing FOUR tool_use blocks (do NOT serialize, do NOT wait between them, issue all four together): \`cat a.txt\`, \`cat b.txt\`, \`cat c.txt\`, \`cat d.txt\`. Then summarize each output. Critical: emit all four Bash tool_use blocks in the SAME assistant message.`;
await runCase({
  caseName: 'parallel-bash-N4',
  files: BASH_FILES,
  prompt: BASH_PROMPT,
  toolName: 'Bash',
  expectedClicks: 4,
});

// === case: parallel-read-N5 ===
// Dogfood G repro shape — 5 parallel Read tool calls (REPORT-RERUN.md
// §A2-NEW-3-PARALLEL-V2). This was the case that pre-fix surfaced ONE
// `tool:Read` block plus N-1 empty `system:Read` blocks. Tightened
// assertion: ALL 5 Read blocks must end up with a tool_result.
const READ_FILES = ['README.md', 'package.json', 'src/strings.js', 'src/math.js', 'src/cart.js'];
// Need to actually create these (some have subdirs).
// runCase seeds files at the top level only; for nested paths we just write
// them in the seeded dir, the case handler creates the directory tree below.
const READ_PROMPT =
  `Use the Read tool to read README.md, package.json, src/strings.js, src/math.js, src/cart.js IN PARALLEL — emit FIVE Read tool_use blocks in a SINGLE assistant message. Do NOT serialize. After all five reads come back, give a 5-line summary, one bullet per file.`;

// runCase only handles flat files; do a tiny inline variant that supports
// nested paths so we can hit the exact dogfood shape.
{
  const caseName = 'parallel-read-N5';
  log(`--- case: ${caseName} ---`);
  const proj = path.join(os.tmpdir(), `agentory-bugl-par-proj-${caseName}-${TS}`);
  fs.mkdirSync(path.join(proj, 'src'), { recursive: true });
  for (const [i, f] of READ_FILES.entries()) {
    fs.writeFileSync(path.join(proj, f), `// file-${i}: ${path.basename(f)} placeholder body for parallel-read probe\n`);
  }

  await win.getByRole('button', { name: /new session/i }).first().click();
  await win.waitForTimeout(1000);
  await win.evaluate((p) => {
    const st = window.__ccsmStore?.getState?.();
    if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
  }, proj);
  await win.waitForTimeout(400);

  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 8000 });
  await ta.click();
  await ta.fill(READ_PROMPT);
  await win.keyboard.press('Enter');
  log(`[${caseName}] prompt sent`);

  const allowSel = '[data-perm-action="allow"]';
  const totalDl = Date.now() + 120_000;
  let lastClickAt = 0;
  let clicks = 0;
  while (Date.now() < totalDl) {
    await win.waitForTimeout(750);
    const visible = await win
      .locator(allowSel)
      .first()
      .isVisible({ timeout: 200 })
      .catch(() => false);
    if (visible) {
      await win.locator(allowSel).first().click();
      clicks += 1;
      lastClickAt = Date.now();
      log(`[${caseName}] clicked Allow #${clicks}`);
      continue;
    }
    if (clicks > 0 && Date.now() - lastClickAt > 8_000) break;
  }
  if (clicks === 0) fail(`[${caseName}] never saw any Allow button within 120s`, app);
  log(`[${caseName}] total Allow clicks: ${clicks}`);

  const obsStart = Date.now();
  let snap;
  while (Date.now() - obsStart < 60_000) {
    await win.waitForTimeout(2000);
    snap = await win
      .evaluate(() => {
        const st = window.__ccsmStore?.getState?.();
        const sid = st?.activeId;
        const blocks = st?.messagesBySession?.[sid] || [];
        const reads = blocks
          .filter((b) => b.kind === 'tool' && (b.toolName || b.name) === 'Read')
          .map((b) => ({
            toolUseId: b.toolUseId,
            id: b.id,
            hasResult: typeof b.result === 'string' && b.result.length > 0,
            isError: b.isError === true,
            resultLen: typeof b.result === 'string' ? b.result.length : 0,
          }));
        const resolvedTraces = blocks.filter(
          (b) =>
            b.kind === 'system' &&
            b.subkind === 'permission-resolved' &&
            (b.decision === 'allowed' || b.decision === 'allow'),
        ).length;
        const allBlockKinds = blocks.map(
          (b) => `${b.kind}:${b.toolName || b.name || ''}:${b.toolUseId || b.id || ''}`,
        );
        return { reads, resolvedTraces, totalBlocks: blocks.length, allBlockKinds };
      })
      .catch(() => null);
    if (
      snap &&
      snap.resolvedTraces >= clicks &&
      snap.reads.length >= clicks &&
      snap.reads.filter((r) => r.hasResult).length >= clicks
    )
      break;
  }

  if (!snap) fail(`[${caseName}] could not snapshot store`, app);
  log(`[${caseName}] final snapshot: reads=${JSON.stringify(snap.reads)} resolvedTraces=${snap.resolvedTraces}`);
  log(`[${caseName}] final allBlocks=${JSON.stringify(snap.allBlockKinds)}`);

  // We expect 5 parallel Read clicks. The model occasionally folds two reads
  // into one batch with sequential follow-ups; tolerate a small undercount
  // (>=4) but require strict equality between clicks and resolved tool blocks.
  if (clicks < 4)
    fail(
      `[${caseName}] expected ~5 parallel Allow clicks (model declined to parallelize?); only saw ${clicks}.`,
      app,
    );

  if (snap.resolvedTraces < clicks)
    fail(
      `[${caseName}] renderer regression: clicked Allow ${clicks}x but only ${snap.resolvedTraces} permission-resolved traces appeared.`,
      app,
    );

  if (snap.reads.length < clicks)
    fail(
      `[${caseName}] Bug L parallel-batch RENDERER regression: ${clicks} Allow clicks but only ${snap.reads.length} \`tool:Read\` blocks exist in store. ` +
        `Parallel tool_use blocks are being coalesced by id (see assistantBlocks). allBlocks=${JSON.stringify(snap.allBlockKinds)}`,
      app,
    );

  const succeeded = snap.reads.filter((r) => r.hasResult);
  if (succeeded.length !== clicks)
    fail(
      `[${caseName}] Bug L parallel-batch IPC/RENDERER regression: ${clicks} Allow clicks but only ${succeeded.length}/${clicks} \`tool:Read\` blocks received a tool_result. ` +
        `reads=${JSON.stringify(snap.reads)} allBlocks=${JSON.stringify(snap.allBlockKinds)}`,
      app,
    );

  const errored = snap.reads.filter((r) => r.isError);
  if (errored.length > 0)
    fail(`[${caseName}] one or more Read tool blocks errored: ${JSON.stringify(errored)}`, app);

  log(
    `[${caseName}] OK: ${clicks} Allow clicks → ${snap.resolvedTraces} resolved traces, ${succeeded.length}/${clicks} Read blocks have tool_result.`,
  );
}

console.log(
  `[probe-bugl-parallel] OK: parallel-bash-N4 + parallel-read-N5 both pass with strict equality (clicks === results).`,
);
await app.close();
cfg.cleanup();
process.exit(0);
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
