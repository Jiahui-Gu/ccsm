// E2E regression probe for PR #174 — fix(streaming): include partial messages
// + chat in-progress dots.
//
// Why a NEW file (not a case in probe-e2e-streaming.mjs): the existing
// probe-e2e-streaming.mjs runs in dev mode and synthesizes streaming by
// calling `streamAssistantText` directly on the store. It NEVER spawns
// claude.exe and NEVER receives a real `stream_event` IPC frame, so it
// would pass even if `--include-partial-messages` were stripped from the
// argv. Same problem with verification/verify-streaming-ux.mjs (it pokes
// the store via setState).
//
// This probe is the wire-level e2e the reviewer required:
//   1. Boots the production bundle in headless Electron.
//   2. Spawns a real claude.exe via the normal `agent:start` IPC flow.
//   3. Hooks `window.ccsm.onAgentEvent` from inside the renderer to
//      capture every IPC frame with its `type`. Counts `stream_event`
//      frames that contain a `content_block_delta(text_delta)` payload —
//      these are the wire-level signature of `--include-partial-messages`.
//   4. Asserts the chat-thinking-dots indicator is visible at T0 (after
//      the user message lands, before any assistant text delta arrives)
//      and gone after the first delta.
//
// Reverse-verify (recorded in dogfood-logs/REVERSE-VERIFY-PR-174.md):
//   - Stash the `--include-partial-messages` line in claude-spawner.ts →
//     rebuild → this probe MUST fail on the "≥2 stream_event frames"
//     assertion.
//   - Stash the dots block in ChatStream.tsx → rebuild → this probe MUST
//     fail on the dots-visible-at-T0 assertion.
//
// === case: streaming-partial-frames ===
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const TS = new Date().toISOString().replace(/[:.]/g, '-');
const UDD = path.join(os.tmpdir(), `agentory-streaming-partial-${TS}`);
const PROJ = path.join(os.tmpdir(), `agentory-streaming-partial-proj-${TS}`);
fs.mkdirSync(UDD, { recursive: true });
fs.mkdirSync(PROJ, { recursive: true });

// A prompt that should produce a moderately long assistant reply so we get
// many text_delta frames. Asks for ~100 words so even if claude is
// terse, we comfortably get >>2 deltas.
const PROMPT =
  'Write a 100-word summary of what TypeScript is. Just the summary, no preamble.';

function log(m) {
  process.stderr.write(`[probe-streaming-partial ${new Date().toISOString()}] ${m}\n`);
}
function fail(msg, app) {
  console.error(`[probe-streaming-partial] FAIL: ${msg}`);
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

// Install the IPC frame recorder inside the renderer BEFORE we trigger
// any session work. We hook `window.ccsm.onAgentEvent` (the same
// channel `subscribeAgentEvents` consumes in src/agent/lifecycle.ts).
// Each captured frame records: type, ts (ms since hook install), and —
// for stream_event frames — the inner event.type and delta.type. We
// also record the wall-clock of the first text_delta so the dots
// timing assertion can use it.
await win.evaluate(() => {
  window.__probeFrames = [];
  window.__probeFirstTextDeltaAt = null;
  const t0 = Date.now();
  const off = window.ccsm.onAgentEvent((e) => {
    const msg = e.message;
    const entry = {
      ts: Date.now() - t0,
      sessionId: e.sessionId,
      type: msg?.type ?? '<no-type>',
    };
    if (msg && msg.type === 'stream_event') {
      const inner = msg.event ?? {};
      entry.eventType = inner.type;
      if (inner.type === 'content_block_delta') {
        entry.deltaType = inner.delta?.type;
        if (inner.delta?.type === 'text_delta' && window.__probeFirstTextDeltaAt === null) {
          window.__probeFirstTextDeltaAt = Date.now();
        }
      }
    }
    window.__probeFrames.push(entry);
  });
  window.__probeOff = off;
});
log('IPC frame recorder installed');

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

// Send the prompt. Right after Enter, we have a small T0 window before
// the first delta arrives — that's where the dots must be visible.
await win.keyboard.press('Enter');
const sentAt = Date.now();
log('prompt sent');

// === Assertion 1: dots visible at T0 ===
// Poll briefly (up to 4s) for the dots to appear after user msg lands.
// They should appear immediately after Enter (running=true, last block=user).
let dotsVisibleAtT0 = false;
const t0Deadline = Date.now() + 4_000;
while (Date.now() < t0Deadline) {
  await win.waitForTimeout(150);
  const v = await win
    .locator('[data-testid="chat-thinking-dots"]')
    .first()
    .isVisible({ timeout: 100 })
    .catch(() => false);
  if (v) {
    dotsVisibleAtT0 = true;
    log(`dots visible at T0 (+${Date.now() - sentAt}ms)`);
    break;
  }
  // If a text_delta has already arrived, T0 window has closed.
  const firstDeltaAt = await win.evaluate(() => window.__probeFirstTextDeltaAt);
  if (firstDeltaAt) {
    log('first text_delta arrived before we observed dots — closing T0 window');
    break;
  }
}
if (!dotsVisibleAtT0) {
  // Dump frames so we can see what actually happened.
  const dump = await win.evaluate(() => window.__probeFrames.slice(0, 30));
  console.error(
    '[probe-streaming-partial] frames seen so far:',
    JSON.stringify(dump, null, 2)
  );
  fail(
    'chat-thinking-dots was NOT visible after user message landed and before first text_delta — Q2 (ChatStream dots) regression',
    app
  );
}

// === Assertion 2: ≥2 stream_event content_block_delta(text_delta) frames ===
// Wait up to 90s for the assistant turn to produce frames. We poll the
// recorder; we don't need to wait for the full turn — we just need to
// observe ≥2 partial frames + a final assistant frame.
const deltaDl = Date.now() + 90_000;
let textDeltaCount = 0;
let sawAssistantFinal = false;
let sawTurnResult = false;
while (Date.now() < deltaDl) {
  await win.waitForTimeout(500);
  const snap = await win.evaluate(() => {
    let textDeltas = 0;
    let assistant = false;
    let result = false;
    for (const f of window.__probeFrames) {
      if (f.type === 'stream_event' && f.eventType === 'content_block_delta' && f.deltaType === 'text_delta') {
        textDeltas++;
      }
      if (f.type === 'assistant') assistant = true;
      if (f.type === 'result') result = true;
    }
    return { textDeltas, assistant, result, total: window.__probeFrames.length };
  });
  textDeltaCount = snap.textDeltas;
  sawAssistantFinal = snap.assistant;
  sawTurnResult = snap.result;
  // We can exit as soon as we have enough deltas AND the turn is done,
  // OR if the turn finished prematurely without enough deltas.
  if (sawTurnResult) break;
  if (textDeltaCount >= 2 && sawAssistantFinal) {
    // Give the renderer a beat to process the final frame, then exit
    // the loop early — we have enough to assert.
    await win.waitForTimeout(2000);
    break;
  }
}
log(
  `frames after wait: text_deltas=${textDeltaCount} assistantFinal=${sawAssistantFinal} result=${sawTurnResult}`
);

if (textDeltaCount < 2) {
  const dump = await win.evaluate(() =>
    window.__probeFrames.map((f) => ({ ts: f.ts, type: f.type, eventType: f.eventType, deltaType: f.deltaType }))
  );
  console.error(
    '[probe-streaming-partial] all frames:',
    JSON.stringify(dump, null, 2)
  );
  fail(
    `expected ≥2 stream_event content_block_delta(text_delta) frames; got ${textDeltaCount}. ` +
      `This is the wire-level signature of --include-partial-messages — Q1 (claude-spawner argv) regression.`,
    app
  );
}

// === Assertion 3: dots GONE after first text_delta ===
// Wait ~2s after the first delta to give the renderer time to flip
// running/lastBlock state and re-render.
const firstDeltaAt = await win.evaluate(() => window.__probeFirstTextDeltaAt);
if (firstDeltaAt) {
  const elapsedSinceFirstDelta = Date.now() - firstDeltaAt;
  if (elapsedSinceFirstDelta < 2000) {
    await win.waitForTimeout(2000 - elapsedSinceFirstDelta);
  }
}
const dotsStillVisible = await win
  .locator('[data-testid="chat-thinking-dots"]')
  .first()
  .isVisible({ timeout: 200 })
  .catch(() => false);
if (dotsStillVisible) {
  fail(
    'chat-thinking-dots was STILL visible >2s after first text_delta arrived — Q2 (ChatStream dots) regression (dots not hidden once assistant text exists)',
    app
  );
}
log('dots gone after first text_delta — OK');

console.log(
  `[probe-streaming-partial] OK: text_delta_frames=${textDeltaCount} dots_at_T0=true dots_after_delta=false`
);
await app.close();
process.exit(0);
