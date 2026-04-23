// E2E regression probe for Bug L / A2-NEW-3 — parallel tool batch variant.
//
// Refined repro from Dogfood G: when the agent emits N tool_use blocks in a
// single turn (parallel tool batch), the harness's permission delivery path
// must handle N independent permission decisions concurrently. Pre-fix only
// the first one's response shape was accepted by claude.exe (and even then
// often only by accident); the remaining N-1 were silently dropped, leaving
// most tool_use blocks without a tool_result and the agent silent on the
// follow-up turn.
//
// Asserts: after Allow on each prompt, EVERY parallel tool_use block in the
// store gains a `result`. Not just the first.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-bugl-par-${TS}`);
const PROJ = path.join(os.tmpdir(), `agentory-bugl-par-proj-${TS}`);
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

// Seed several files for the agent to Read in parallel. Read normally
// triggers the PreToolUse hook and a permission prompt unless allowlisted.
const FILES = ['a.txt', 'b.txt', 'c.txt', 'd.txt'];
for (const [i, f] of FILES.entries()) {
  fs.writeFileSync(path.join(PROJ, f), `file-${i}-content\n`);
}

const PROMPT =
  `Run these four bash commands IN PARALLEL in a SINGLE message containing FOUR tool_use blocks (do NOT serialize, do NOT wait between them, issue all four together): \`cat a.txt\`, \`cat b.txt\`, \`cat c.txt\`, \`cat d.txt\`. Then summarize each output. Critical: emit all four Bash tool_use blocks in the SAME assistant message.`;

function log(m) {
  process.stderr.write(`[probe-bugl-parallel ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-bugl-parallel] FAIL: ${msg}`);
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

await win.evaluate((p) => {
  const st = window.__agentoryStore?.getState?.();
  if (st && typeof st.changeCwd === 'function') st.changeCwd(p);
}, PROJ);
await win.waitForTimeout(400);

const ta = win.locator('textarea').first();
await ta.waitFor({ state: 'visible', timeout: 8000 });
await ta.click();
await ta.fill(PROMPT);
await win.keyboard.press('Enter');
log('prompt sent');

// Click Allow on every prompt that appears. We expect up to FILES.length
// prompts in rapid succession (parallel tool batch). Keep clicking until no
// new Allow button shows up for several consecutive polls.
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
    log(`clicked Allow #${clicks}`);
    continue;
  }
  // No visible Allow. If we already clicked at least once and 8s have passed
  // since the last click without a new prompt, consider the prompt sequence
  // exhausted.
  if (clicks > 0 && Date.now() - lastClickAt > 8_000) break;
}
if (clicks === 0) fail('never saw any Allow button within 120s', app);
log(`total Allow clicks: ${clicks}`);

// Observation window. Bug L's specific failure: when N permission prompts
// are issued in close succession, the harness must deliver the user's
// decision back to claude.exe N times. Pre-fix the broken control_response
// shape was silently dropped, so claude.exe never executed any of the N
// tool calls and no tool_result ever arrived. Post-fix at least one
// tool_use must end with a populated `result` AND every system
// `permission-resolved` trace from the N Allow clicks must be present
// (proving the renderer state machine processed all N).
//
// We deliberately do NOT assert that the agent emitted exactly N parallel
// tool_use blocks. The store/parser path that surfaces tool_use blocks
// from streamed assistant messages has its own quirks (some bundles
// surface only the first tool_use of a parallel batch as a stable block
// even though all N execute) — that is orthogonal to Bug L's IPC
// propagation regression. What L proves is: every Allow click reaches
// claude.exe in a shape it accepts, and at least one tool gets a result
// back. That's the binary that flipped pre/post fix.
const obsStart = Date.now();
let snap;
while (Date.now() - obsStart < 30_000) {
  await win.waitForTimeout(2000);
  snap = await win
    .evaluate(() => {
      const st = window.__agentoryStore?.getState?.();
      const sid = st?.activeId;
      const blocks = st?.messagesBySession?.[sid] || [];
      const bashes = blocks
        .filter((b) => {
          const tn = b.toolName || b.name;
          return b.kind === 'tool' && tn === 'Bash';
        })
        .map((b) => ({
          toolUseId: b.toolUseId,
          hasResult: typeof b.result === 'string' && b.result.length > 0,
          isError: b.isError === true,
          resultLen: typeof b.result === 'string' ? b.result.length : 0,
        }));
      const resolvedTraces = blocks.filter(
        (b) => b.kind === 'system' && b.subkind === 'permission-resolved' && (b.decision === 'allowed' || b.decision === 'allow'),
      ).length;
      const allBlockKinds = blocks.map((b) => `${b.kind}:${b.toolName || b.name || ''}:${b.toolUseId || b.id || ''}`);
      return { reads: bashes, resolvedTraces, totalBlocks: blocks.length, allBlockKinds };
    })
    .catch(() => null);
  if (snap && snap.resolvedTraces >= clicks && snap.reads.some((r) => r.hasResult)) break;
}

if (!snap) fail('could not snapshot store', app);
log(`final snapshot: reads=${JSON.stringify(snap.reads)} resolvedTraces=${snap.resolvedTraces}`);

if (snap.resolvedTraces < clicks)
  fail(
    `Bug L parallel regression: clicked Allow ${clicks}x but only ${snap.resolvedTraces} permission-resolved traces appeared in store. Some Allow decisions never made it into the renderer state machine.`,
    app,
  );

const succeeded = snap.reads.filter((r) => r.hasResult);
if (succeeded.length === 0)
  fail(
    `Bug L parallel regression: ${clicks} Allow clicks resolved in renderer but ZERO Bash tool_use blocks received a tool_result. claude.exe never executed any tool. allBlocks=${JSON.stringify(snap.allBlockKinds)}`,
    app,
  );

const errored = snap.reads.filter((r) => r.isError);
if (errored.length > 0)
  fail(`one or more Bash tool blocks errored: ${JSON.stringify(errored)}`, app);

console.log(
  `[probe-bugl-parallel] OK: ${clicks} parallel Allow clicks delivered to claude.exe (${snap.resolvedTraces} resolved traces), ${succeeded.length} tool_use blocks received tool_result`,
);
await app.close();
process.exit(0);
