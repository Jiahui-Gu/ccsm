// scripts/dogfood-jsonl-tail-loss-on-reload.mjs
//
// Empirical reproduction for the "reload loses tail-end context" bug.
//
// Hypothesis under test (from electron/ptyHost/lifecycle.ts:164-180): the
// claude CLI buffers JSONL transcript entries and does NOT fsync, so a reload
// (kill PTY -> respawn with --resume) that lands inside the flush window loses
// whatever the CLI had queued but not yet written. After respawn,
// `claude --resume <sid>` rebuilds context from the ON-DISK JSONL, so the
// missing tail is gone permanently.
//
// IMPORTANT: the old root-cause note was written against the legacy Node
// `cli.js` bundle. The installed CLI is now a native `claude.exe` (2.x) whose
// flush behaviour is unverifiable by code-reading. This probe measures the
// real on-disk JSONL across a reload to confirm whether the bug still exists
// and how much is lost.
//
// Method:
//   1. seed session, reach interactive claude, clear first-run modals
//   2. send a real user message, wait for claude to answer (a full turn lands
//      in the JSONL: one `user` line + one or more `assistant` lines)
//   3. snapshot the JSONL line count + last entry
//   4. send a SECOND user message and reload AS FAST AS POSSIBLE after the
//      send (target the flush window) — do NOT wait for the answer
//   5. after reload settles, re-read the JSONL from disk and check whether the
//      second user message survived
//
// Exit 0 = tail survived (no loss, or loss fully recovered). Exit 1 = tail
// lost (bug reproduced) OR harness failure.

import { mkdtempSync, readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  dismissWelcomeSplash,
  launchCcsmIsolated,
  seedSession,
  sendToClaudeTui,
  waitForTerminalReady,
  waitForXtermBuffer,
} from './probe-utils-real-cli.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let exitCode = 0;
function fail(msg) { console.error('FAIL:', msg); exitCode = 1; }

async function dumpScreen(win, label) {
  const screen = await win.evaluate(() => {
    const t = window.__ccsmTerm;
    if (!t) return '(no term)';
    const buf = t.buffer.active;
    const lines = [];
    for (let i = 0; i < buf.length; i++) {
      const l = buf.getLine(i);
      if (l) lines.push(l.translateToString(true));
    }
    return lines.join('\n').replace(/\n{3,}/g, '\n\n');
  }).catch((e) => `(dump failed: ${e.message})`);
  console.log(`\n===== SCREEN [${label}] =====\n${screen}\n===== END [${label}] =====\n`);
}

const MARKER_1 = 'PROBE_FIRST_TURN_marker_alpha';

// Scan the isolated CLAUDE_CONFIG_DIR/projects/*/ for any *.jsonl with size>0.
// Returns the absolute path of the most-recently-modified one, or null.
function findActiveJsonl(tempDir) {
  const projectsRoot = path.join(tempDir, 'projects');
  if (!existsSync(projectsRoot)) return null;
  let best = null;
  let bestMtime = -1;
  for (const proj of readdirSync(projectsRoot)) {
    const projDir = path.join(projectsRoot, proj);
    let names;
    try { names = readdirSync(projDir); } catch { continue; }
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const p = path.join(projDir, name);
      try {
        const st = statSync(p);
        if (st.isFile() && st.size > 0 && st.mtimeMs > bestMtime) {
          best = p; bestMtime = st.mtimeMs;
        }
      } catch { /* gone */ }
    }
  }
  return best;
}

function readJsonlEntries(p) {
  if (!p || !existsSync(p)) return [];
  const raw = readFileSync(p, 'utf8');
  const out = [];
  for (const line of raw.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t)); } catch { /* partial tail line */ }
  }
  return out;
}

// Concatenate all assistant text in the JSONL, then find the highest N such
// that every integer 1..N appears (in order) as its own line. This is the
// "how far did the counting reply survive" measure: a truncated streaming tail
// shows up as a ceiling well below the requested COUNT_TO.
function highestContiguousCount(entries, max) {
  const texts = [];
  for (const e of entries) {
    if (e?.message?.role !== 'assistant' && e?.type !== 'assistant') continue;
    const c = e?.message?.content;
    if (typeof c === 'string') texts.push(c);
    else if (Array.isArray(c)) {
      for (const block of c) if (typeof block?.text === 'string') texts.push(block.text);
    }
  }
  const blob = texts.join('\n');
  let high = 0;
  for (let n = 1; n <= max; n++) {
    if (new RegExp(`(^|\\s)${n}(\\s|$)`, 'm').test(blob)) high = n;
    else break;
  }
  return high;
}

// Does any entry's text content contain the marker? (user messages store text
// under message.content as string or [{type:'text',text}]).
function jsonlContainsMarker(entries, marker) {
  for (const e of entries) {
    const c = e?.message?.content;
    if (typeof c === 'string' && c.includes(marker)) return true;
    if (Array.isArray(c)) {
      for (const block of c) {
        if (typeof block?.text === 'string' && block.text.includes(marker)) return true;
      }
    }
    // Fallback: raw stringify (covers shape drift across CLI versions).
    try { if (JSON.stringify(e).includes(marker)) return true; } catch { /* ignore */ }
  }
  return false;
}

async function main() {
  const { tempDir } = await createIsolatedClaudeDir();
  const cwd = mkdtempSync(path.join(tmpdir(), 'ccsm-jsonltail-cwd-'));

  const { electronApp, win } = await launchCcsmIsolated({
    tempDir,
    env: {
      CCSM_E2E_HIDDEN: '1',
      // claude refuses to run when BOTH ANTHROPIC_AUTH_TOKEN and
      // ANTHROPIC_API_KEY are present ("Auth conflict"). The dev shell here
      // has both; keep only the proxy API key for the isolated child.
      ANTHROPIC_AUTH_TOKEN: '',
    },
  });

  const visibilityProbe = await electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows().map((w) => {
      const b = w.getBounds();
      return { offscreen: b.x <= -10000 && b.y <= -10000 };
    }),
  );
  if (!visibilityProbe.every((w) => w.offscreen)) {
    await electronApp.close().catch(() => {});
    throw new Error(`window not offscreen: ${JSON.stringify(visibilityProbe)}`);
  }

  const { sid } = await seedSession(win, { cwd, name: 'jsonl-tail' });
  await waitForTerminalReady(win, sid, { timeout: 45000 });
  await waitForXtermBuffer(win, /claude|welcome|│|╭|\?\sfor\sshortcuts/i, { timeout: 30000 });
  await dismissWelcomeSplash(win);
  await sleep(1000);
  await dumpScreen(win, 'after-splash-dismiss');
  // Fresh isolated config dir => full first-run onboarding gauntlet:
  //   trust folder · "use this API key?" (default = No!) · security notes ·
  //   welcome card. Drive each to its accept choice until the input prompt
  //   (│ >) is visible. The API-key screen is the dangerous one: a bare Enter
  //   selects "No (recommended)" and claude then runs with NO credentials.
  const promptRe = /│\s*>|^\s*>\s/m;
  const trustRe = /trust this folder|Is this a project you/i;
  const apiKeyRe = /use this API key|custom API key/i;
  const continueRe = /Press Enter to continue|Security notes/i;
  let reachedPrompt = false;
  for (let i = 0; i < 20; i++) {
    const screen = await win.evaluate(() => {
      const t = window.__ccsmTerm; if (!t) return '';
      const b = t.buffer.active; const out = [];
      for (let k = 0; k < b.length; k++) { const l = b.getLine(k); if (l) out.push(l.translateToString(true)); }
      return out.join('\n');
    }).catch(() => '');
    if (promptRe.test(screen) && !trustRe.test(screen) && !apiKeyRe.test(screen)) { reachedPrompt = true; break; }
    if (apiKeyRe.test(screen)) {
      await sendToClaudeTui(win, '1');          // "Yes" use the API key
      await sleep(200);
      await sendToClaudeTui(win, '\r');
    } else if (trustRe.test(screen)) {
      await sendToClaudeTui(win, '1');
      await sleep(200);
      await sendToClaudeTui(win, '\r');
    } else if (continueRe.test(screen)) {
      await sendToClaudeTui(win, '\r');
    } else {
      await sendToClaudeTui(win, '\r');          // generic splash advance
    }
    await sleep(900);
  }
  await dumpScreen(win, `after-onboarding(reachedPrompt=${reachedPrompt})`);

  // --- TURN 1: send a message, WAIT for the answer to fully land on disk. ---
  await sendToClaudeTui(win, `Reply with exactly: ${MARKER_1}`);
  await sleep(300);
  await sendToClaudeTui(win, '\r');

  // Wait until the first turn is durably on disk (poll the JSONL).
  let jsonlPath = null;
  for (let i = 0; i < 25; i++) {
    await sleep(1000);
    jsonlPath = findActiveJsonl(tempDir);
    const entries = readJsonlEntries(jsonlPath);
    if (jsonlContainsMarker(entries, MARKER_1)) break;
  }
  const beforeEntries = readJsonlEntries(jsonlPath);
  const turn1OnDisk = jsonlContainsMarker(beforeEntries, MARKER_1);
  console.log(`[turn1] jsonl=${jsonlPath}`);
  console.log(`[turn1] entries=${beforeEntries.length} marker1OnDisk=${turn1OnDisk}`);
  if (!turn1OnDisk) {
    await dumpScreen(win, 'turn1-timeout');
    fail('turn1 never reached JSONL — claude did not answer (auth? OAuth wall?). Cannot test reload tail-loss.');
    await electronApp.close().catch(() => {});
    return;
  }

  // --- TURN 2: the REAL tail-loss window ---------------------------------
  // The earlier version of this probe measured whether a *user* message
  // survived reload. A sweep across reload delays (0/30/80/150ms) showed it
  // ALWAYS survived: claude 2.x's graceful SIGINT flush (ccsm writes \x03 then
  // waits up to KILL_EXIT_TIMEOUT_MS=3000ms) durably persists the user turn.
  // So user-message loss is NOT the bug on this CLI version.
  //
  // The actual "tail-end context" that disappears is the ASSISTANT's reply
  // that is STILL STREAMING when the user hits reload. Reload kills the PTY
  // mid-generation; claude flushes whatever it had, then `--resume` rebuilds
  // context from the on-disk JSONL. Any assistant tokens generated-but-not-yet
  // -flushed at kill time are gone — that's the lost tail.
  //
  // To measure it we ask claude for a long, DETERMINISTIC, position-checkable
  // reply (count 1..N, one per line). We reload WHILE it is mid-stream
  // (detected by the xterm buffer showing low numbers but not yet the high
  // ones), then read the on-disk JSONL assistant message and find the highest
  // contiguous number that survived. If it's well below N, the tail was lost.
  const COUNT_TO = Number(process.env.CCSM_COUNT_TO ?? '400');
  await sendToClaudeTui(
    win,
    `Count from 1 to ${COUNT_TO}, one number per line, nothing else. Start now.`,
  );
  await sleep(300);
  await sendToClaudeTui(win, '\r');

  // Reload at the EARLIEST sign of streaming: the first number ("1") visible
  // in the xterm buffer. That maximises the chance of catching claude with an
  // in-flight, not-yet-flushed assistant turn — the worst case for tail loss.
  let reloadedAt = -1;
  for (let i = 0; i < 400; i++) {
    await sleep(25);
    const screen = await win.evaluate(() => {
      const t = window.__ccsmTerm; if (!t) return '';
      const b = t.buffer.active; const out = [];
      for (let k = 0; k < b.length; k++) { const l = b.getLine(k); if (l) out.push(l.translateToString(true)); }
      return out.join('\n');
    }).catch(() => '');
    const sawEnd = new RegExp(`(^|\\s)${COUNT_TO}(\\s|$)`, 'm').test(screen);
    // first standalone "1" that is part of the counting reply (after the prompt)
    const sawStart = /(^|\s)1(\s|$)[\s\S]*?(^|\s)2(\s|$)/m.test(screen);
    if (sawEnd) { reloadedAt = -2; break; } // finished before we could catch it
    if (sawStart) { reloadedAt = i; break; }
  }
  console.log(`[turn2] earliest-stream detect: reloadedAt=${reloadedAt} (end=${COUNT_TO})`);

  // Snapshot what reached disk just before we pull the plug.
  const preReloadHigh = highestContiguousCount(readJsonlEntries(jsonlPath), COUNT_TO);
  console.log(`[turn2] highestContiguousCountOnDisk(before reload)=${preReloadHigh}`);

  await win.evaluate((s) => window.__ccsmStore.getState().reloadSession(s), sid);
  await win.waitForFunction(
    (s) => (window.__ccsmStore.getState().reloadNonce[s] ?? 0) > 0,
    sid,
    { timeout: 20000 },
  );
  await win.waitForFunction(
    (s) => {
      const w = document.querySelector(`[data-ccsm-shell-sid="${s}"]`);
      const mask = w?.querySelector('[data-ccsm-shell-mask]');
      return mask instanceof HTMLElement && mask.style.display === 'none';
    },
    sid,
    { timeout: 30000 },
  );

  // After resume settles, read disk again. The assistant turn is now frozen at
  // whatever claude flushed during the graceful-kill window.
  await sleep(5000);
  const afterPath = findActiveJsonl(tempDir);
  const afterEntries = readJsonlEntries(afterPath);
  const turn1Survived = jsonlContainsMarker(afterEntries, MARKER_1);
  const afterHigh = highestContiguousCount(afterEntries, COUNT_TO);

  console.log(`[after-reload] jsonl=${afterPath}`);
  console.log(`[after-reload] entries=${afterEntries.length} marker1=${turn1Survived} highestContiguousCount=${afterHigh}/${COUNT_TO}`);

  // Dump every assistant entry's raw text + the trailing user entries so we can
  // see EXACTLY what the on-disk transcript looks like (atomic full reply? a
  // truncated partial? an [Request interrupted by user] marker?).
  console.log('[after-reload] --- transcript tail ---');
  for (const e of afterEntries.slice(-6)) {
    const role = e?.message?.role || e?.type;
    let c = e?.message?.content, txt = '';
    if (typeof c === 'string') txt = c;
    else if (Array.isArray(c)) txt = c.map((b) => b?.text || (b?.type ? `[${b.type}]` : '')).join('');
    const oneLine = txt.replace(/\n/g, '|');
    console.log(`  [${role}] ${txt.length}ch: ${oneLine.slice(0, 200)}${oneLine.length > 200 ? '…' + oneLine.slice(-40) : ''}`);
  }

  if (!turn1Survived) {
    fail('CATASTROPHIC: turn1 (durably on disk pre-reload) vanished after reload.');
  }
  if (reloadedAt === -2) {
    console.log('INCONCLUSIVE: stream finished before mid-stream reload could fire (increase CCSM_COUNT_TO).');
  } else if (afterHigh < COUNT_TO) {
    // The assistant reply on disk is truncated — the streaming tail was lost.
    fail(`ASSISTANT-STREAM TAIL LOSS REPRODUCED: on-disk assistant reply reaches ${afterHigh} but was asked to count to ${COUNT_TO}. The ${COUNT_TO - afterHigh} trailing line(s) generated-but-unflushed at reload are gone after --resume.`);
  } else {
    console.log(`PASS: assistant reply fully persisted to ${afterHigh}/${COUNT_TO} despite mid-stream reload — no tail loss at this timing.`);
  }

  await electronApp.close().catch(() => {});
}

main().then(() => process.exit(exitCode)).catch((err) => {
  console.error('FAIL:', err?.stack ?? err);
  process.exit(1);
});
