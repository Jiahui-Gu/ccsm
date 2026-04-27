// Dogfood r2 fp11 — i18n (Chinese) + markdown rendering + long output handling.
//
// Drives installed CCSM.exe against the Agent Maestro proxy and exercises:
//   A. Chinese prompt + Chinese assistant reply, no mojibake.
//   B. Full markdown element rendering (h1 / ul / ol / code block / blockquote
//      / bold / italic / inline code).
//   C. Long output (count to 200) — scroll behavior + auto-stick-to-bottom.
//   D. Long markdown — truncation / "show more" affordance, if any.
//   E. Mixed CJK + English prompt round-trip.
//   F. Single 500-char line — wrap / overflow handling.
//
// Output:
//   - docs/screenshots/dogfood-r2/fp11-i18n-md-long/check-{a..f}*.png
//   - dogfood-logs/r2-fp11/probe.log + per-step JSON snapshots
//   - findings.json

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp11-i18n-md-long');
const LOG_DIR = path.join(REPO_ROOT, 'dogfood-logs/r2-fp11');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const CCSM_EXE = 'C:\\Users\\jiahuigu\\AppData\\Local\\Programs\\CCSM\\CCSM.exe';
const USER_DATA = 'C:\\temp\\ccsm-dogfood-r2-fp11';
if (fs.existsSync(USER_DATA)) {
  fs.rmSync(USER_DATA, { recursive: true, force: true });
}
fs.mkdirSync(USER_DATA, { recursive: true });

const PROBE_CWD = path.join(os.tmpdir(), `ccsm-fp11-cwd-${Date.now()}`);
fs.mkdirSync(PROBE_CWD, { recursive: true });
fs.writeFileSync(path.join(PROBE_CWD, 'README.md'), 'fp11 probe sandbox\n', 'utf8');

const logPath = path.join(LOG_DIR, 'probe.log');
const logLines = [];
function log(...args) {
  const line = args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ');
  console.log(line);
  logLines.push(`[${new Date().toISOString()}] ${line}`);
  fs.writeFileSync(logPath, logLines.join('\n'), 'utf8');
}

const findings = {};
function record(key, status, detail) {
  findings[key] = { status, detail };
  log(`==> ${key}: ${status}`, detail ?? '');
}

// Sanitize HOME-leaking skill env. Per fp10 gotcha set BOTH
// CCSM_CLAUDE_CONFIG_DIR (consumed by main process) AND CLAUDE_CONFIG_DIR
// (renderer's commands-loader reads the bare one).
const claudeConfigDir = path.join(os.homedir(), '.claude');
const env = {
  ...process.env,
  ANTHROPIC_BASE_URL: 'http://localhost:23333/api/anthropic',
  CCSM_CLAUDE_CONFIG_DIR: claudeConfigDir,
  CLAUDE_CONFIG_DIR: claudeConfigDir,
  CCSM_USER_DATA_DIR: USER_DATA
};

log('launching CCSM', { CCSM_EXE, USER_DATA, PROBE_CWD });

const app = await electron.launch({
  executablePath: CCSM_EXE,
  args: [`--user-data-dir=${USER_DATA}`],
  env,
  timeout: 60_000
});

let win;
try {
  win = await appWindow(app, { timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 30_000 });
  await win.waitForTimeout(800);

  async function shoot(name) {
    const file = path.join(SHOTS_DIR, `${name}.png`);
    await win.screenshot({ path: file });
    log(`captured ${file}`);
  }

  async function snapshotStore(label) {
    const snap = await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      const sid = s.activeId;
      const msgs = (s.messagesBySession?.[sid] || []).map((b) => ({
        kind: b.kind,
        id: b.id,
        text: typeof b.text === 'string' ? b.text : undefined
      }));
      return {
        activeId: sid,
        running: !!s.runningSessions?.[sid],
        messageCount: msgs.length,
        blocks: msgs,
        statsCostUsd: s.sessionStats?.[sid]?.costUsd ?? null,
        contextUsage: s.contextUsageBySession?.[sid] ?? null
      };
    });
    fs.writeFileSync(path.join(LOG_DIR, `snap-${label}.json`), JSON.stringify(snap, null, 2));
    log(`snap[${label}] count=${snap.messageCount} running=${snap.running}`);
    return snap;
  }

  async function ensureSession() {
    const sid = await win.evaluate(async (cwd) => {
      const st = window.__ccsmStore.getState();
      let id = st.activeId;
      if (!id) {
        if (typeof st.createSession === 'function') id = st.createSession(cwd);
      }
      if (id) {
        const s2 = window.__ccsmStore.getState();
        const sess = (s2.sessions || []).find((x) => x.id === id);
        if (sess && !sess.cwd) {
          window.__ccsmStore.setState((cur) => ({
            sessions: cur.sessions.map((x) => (x.id === id ? { ...x, cwd } : x))
          }));
        }
      }
      return id;
    }, PROBE_CWD);
    log('ensured session', { sid });
    return sid;
  }

  async function dismissOnboarding() {
    for (let i = 0; i < 3; i++) {
      const onb = win.locator('[data-onboarding], [data-tutorial], [role="dialog"]').first();
      if (await onb.isVisible().catch(() => false)) {
        await win.keyboard.press('Escape');
        await win.waitForTimeout(300);
      } else break;
    }
  }

  await dismissOnboarding();
  await shoot('00-app-launched');

  const sid = await ensureSession();
  await win.waitForTimeout(400);
  await shoot('01-session-ready');

  async function sendPrompt(text, { timeoutMs = 180_000 } = {}) {
    log(`sending prompt (${text.length} chars)`);
    const ta = win.locator('textarea[data-input-bar]').first();
    await ta.waitFor({ state: 'visible', timeout: 15_000 });
    await ta.click();
    await ta.fill(text);
    await win.waitForTimeout(150);
    await win.keyboard.press('Enter');
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const stillRunning = await win.evaluate(() => {
        const s = window.__ccsmStore.getState();
        return !!s.runningSessions?.[s.activeId];
      });
      if (!stillRunning) {
        const hasAssistant = await win.evaluate(() => {
          const s = window.__ccsmStore.getState();
          const ms = s.messagesBySession?.[s.activeId] || [];
          return ms.some((b) => b.kind === 'assistant' || b.kind === 'error');
        });
        if (hasAssistant) break;
      }
      await win.waitForTimeout(500);
    }
    await win.waitForTimeout(500);
    const elapsed = Date.now() - start;
    log(`prompt settled in ${elapsed}ms`);
  }

  async function getLastAssistantText() {
    return await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      const ms = s.messagesBySession?.[s.activeId] || [];
      for (let i = ms.length - 1; i >= 0; i--) {
        if (ms[i].kind === 'assistant') return ms[i].text || '';
      }
      return '';
    });
  }

  async function getLastAssistantId() {
    return await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      const ms = s.messagesBySession?.[s.activeId] || [];
      for (let i = ms.length - 1; i >= 0; i--) {
        if (ms[i].kind === 'assistant') return ms[i].id;
      }
      return null;
    });
  }

  // ===== CHECK A: Chinese prompt + Chinese reply =====
  log('CHECK A: Chinese prompt');
  const promptA = '用三句话介绍一下今天天气怎么测，很感谢';
  await sendPrompt(promptA);
  const replyA = await getLastAssistantText();
  await snapshotStore('check-a');
  await shoot('check-a-chinese');
  const cjkRe = /[一-鿿]/;
  const replyCjkCount = (replyA.match(/[一-鿿]/g) || []).length;
  // Mojibake heuristic: any U+FFFD or sequences of '?' replacing CJK.
  const hasMojibake = replyA.includes('�') || /\?{4,}/.test(replyA);
  log('reply A (first 300):', replyA.slice(0, 300));
  if (replyA && replyCjkCount >= 10 && !hasMojibake) {
    record('A', 'PASS', `Chinese reply received (${replyCjkCount} CJK chars, ${replyA.length} total). No mojibake.`);
  } else if (!replyA) {
    record('A', 'FAIL', 'No assistant reply for Chinese prompt.');
  } else if (hasMojibake) {
    record('A', 'FAIL', `Mojibake detected: U+FFFD or ???? present. Reply length=${replyA.length}.`);
  } else {
    record('A', 'PARTIAL', `Reply has only ${replyCjkCount} CJK chars (length=${replyA.length}). Maybe model answered in English.`);
  }

  // ===== CHECK B: Markdown element rendering =====
  log('CHECK B: markdown elements');
  const promptB =
    "Please respond with EXACTLY this markdown (no extra commentary). Reply ONLY with the markdown content below:\n\n" +
    "# Heading One\n\n" +
    "Unordered list:\n- alpha\n- beta\n- gamma\n\n" +
    "Ordered list:\n1. first\n2. second\n3. third\n\n" +
    "```javascript\nconsole.log('hello world');\n```\n\n" +
    "> a quoted line\n\n" +
    "This has **bold word** and *italic word* and inline `foo` code.\n";
  await sendPrompt(promptB);
  const replyB = await getLastAssistantText();
  const lastBId = await getLastAssistantId();
  await snapshotStore('check-b');
  log('reply B (first 500):', replyB.slice(0, 500));

  // Inspect rendered DOM for the last assistant block.
  const rendered = await win.evaluate(() => {
    const all = document.querySelectorAll('[data-type-scale-role="assistant-body"]');
    const root = all[all.length - 1];
    if (!root) {
      return { _diag: { count: all.length, ids: Array.from(all).map((e) => e.getAttribute('data-assistant-block-id')) } };
    }
    const h1 = root.querySelector('h1');
    const ul = root.querySelector('ul');
    const ulItems = ul ? Array.from(ul.querySelectorAll('li')).length : 0;
    const ol = root.querySelector('ol');
    const olItems = ol ? Array.from(ol.querySelectorAll('li')).length : 0;
    const pre = root.querySelector('pre');
    const codeInPre = pre ? pre.querySelector('code') : null;
    const blockquote = root.querySelector('blockquote');
    const strong = root.querySelector('strong');
    const em = root.querySelector('em');
    // inline code: a <code> not inside <pre>
    const inlineCodes = Array.from(root.querySelectorAll('code')).filter((c) => !c.closest('pre'));
    function styleOf(el) {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        fontWeight: cs.fontWeight,
        fontStyle: cs.fontStyle,
        fontFamily: cs.fontFamily,
        listStyleType: cs.listStyleType,
        backgroundColor: cs.backgroundColor,
        borderLeft: cs.borderLeftWidth + ' ' + cs.borderLeftStyle + ' ' + cs.borderLeftColor,
        paddingLeft: cs.paddingLeft,
        marginLeft: cs.marginLeft,
        display: cs.display
      };
    }
    const bodyP = root.querySelector('p');
    return {
      hasH1: !!h1,
      h1Text: h1?.textContent?.slice(0, 80) ?? null,
      h1Style: styleOf(h1),
      bodyStyle: styleOf(bodyP),
      ulItems,
      ulStyle: styleOf(ul),
      olItems,
      olStyle: styleOf(ol),
      hasPre: !!pre,
      preFont: codeInPre ? styleOf(codeInPre).fontFamily : null,
      preLang: codeInPre?.className ?? null,
      hasBlockquote: !!blockquote,
      blockquoteStyle: styleOf(blockquote),
      hasStrong: !!strong,
      strongStyle: styleOf(strong),
      hasEm: !!em,
      emStyle: styleOf(em),
      inlineCodeCount: inlineCodes.length,
      inlineCodeStyle: inlineCodes[0] ? styleOf(inlineCodes[0]) : null
    };
  }, lastBId);
  // Treat as failure-to-find if returned only the diagnostic shape.
  if (rendered && rendered._diag) {
    log('check-b NO assistant block found in DOM. data-assistant-block-id values present:', rendered._diag);
  }
  fs.writeFileSync(path.join(LOG_DIR, 'check-b-dom.json'), JSON.stringify(rendered, null, 2));
  log('check-b rendered analysis', rendered);
  await shoot('check-b-markdown');

  if (!rendered) {
    record('B', 'FAIL', 'No assistant block found in DOM.');
  } else {
    const issues = [];
    // h1 visually different from body
    const h1Px = parseFloat(rendered.h1Style?.fontSize ?? '0');
    const bodyPx = parseFloat(rendered.bodyStyle?.fontSize ?? '0');
    const h1Bigger = h1Px > bodyPx;
    if (!rendered.hasH1) issues.push('no <h1>');
    else if (!h1Bigger && parseInt(rendered.h1Style.fontWeight) < 600)
      issues.push(`h1 not visually distinct: size=${h1Px} vs body=${bodyPx}, weight=${rendered.h1Style.fontWeight}`);
    if (rendered.ulItems < 3) issues.push(`ul has ${rendered.ulItems} items (<3)`);
    if (rendered.olItems < 3) issues.push(`ol has ${rendered.olItems} items (<3)`);
    if (!rendered.hasPre) issues.push('no <pre> code block');
    else if (!/mono|courier|consolas|menlo/i.test(rendered.preFont || ''))
      issues.push(`code block font not monospace: ${rendered.preFont}`);
    if (!rendered.hasBlockquote) issues.push('no <blockquote>');
    if (!rendered.hasStrong) issues.push('no <strong>');
    else if (parseInt(rendered.strongStyle.fontWeight) < 600)
      issues.push(`strong weight=${rendered.strongStyle.fontWeight} not bold`);
    if (!rendered.hasEm) issues.push('no <em>');
    else if (rendered.emStyle.fontStyle !== 'italic')
      issues.push(`em font-style=${rendered.emStyle.fontStyle} not italic`);
    if (rendered.inlineCodeCount < 1) issues.push('no inline <code>');
    else if (!/mono|courier|consolas|menlo/i.test(rendered.inlineCodeStyle.fontFamily || ''))
      issues.push(`inline code not monospace: ${rendered.inlineCodeStyle.fontFamily}`);
    if (issues.length === 0) {
      record('B', 'PASS', `All markdown elements rendered correctly. h1=${h1Px}px(${rendered.h1Style.fontWeight}) body=${bodyPx}px ul=${rendered.ulItems} ol=${rendered.olItems} pre+mono blockquote bold italic inlineCode=${rendered.inlineCodeCount}.`);
    } else if (issues.length <= 2) {
      record('B', 'PARTIAL', `Most elements rendered; issues: ${issues.join('; ')}`);
    } else {
      record('B', 'FAIL', `Multiple rendering issues: ${issues.join('; ')}`);
    }
  }

  // ===== CHECK C: long output, scroll-to-bottom auto-stick =====
  log('CHECK C: long output (count to 200)');
  // Snapshot scroll state right before sending.
  await sendPrompt('count from 1 to 200 one per line. Output ONLY the numbers, nothing else.', { timeoutMs: 240_000 });
  const replyC = await getLastAssistantText();
  await snapshotStore('check-c');
  // Capture scroll metrics post-stream.
  const scrollMetrics = await win.evaluate(() => {
    const el = document.querySelector('[data-chat-stream]');
    if (!el) return null;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    return {
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
      scrollTop: el.scrollTop,
      distanceFromBottom,
      atBottom: distanceFromBottom <= 24
    };
  });
  log('scroll metrics post-stream', scrollMetrics);
  await shoot('check-c-long-output-bottom');
  // Count line entries in reply
  const replyCLines = replyC.split('\n').filter((l) => /^\s*\d+/.test(l));
  log('reply C: lines containing numbers =', replyCLines.length);
  // Scroll to top, verify scrollback works.
  await win.evaluate(() => {
    const el = document.querySelector('[data-chat-stream]');
    if (el) el.scrollTo({ top: 0 });
  });
  await win.waitForTimeout(400);
  await shoot('check-c-scrolled-to-top');
  const afterScrollUp = await win.evaluate(() => {
    const el = document.querySelector('[data-chat-stream]');
    return { scrollTop: el?.scrollTop ?? -1, scrollHeight: el?.scrollHeight ?? 0 };
  });
  log('after scroll up', afterScrollUp);
  // Look for jump-to-latest button (set when not at bottom).
  const jumpBtnVisible = await win.evaluate(() => {
    // ChatStream renders a jump button when showJump=true. It's typically a
    // floating circle near the bottom; we detect by aria-label or any button
    // inside the chat region containing 'bottom' or 'latest'.
    const candidates = Array.from(document.querySelectorAll('button'));
    const found = candidates.find((b) => /bottom|latest|jump|滚到底|最底|最新/i.test(b.textContent || b.getAttribute('aria-label') || ''));
    return found ? { text: found.textContent?.slice(0, 60), aria: found.getAttribute('aria-label') } : null;
  });
  log('jump-to-bottom button', jumpBtnVisible);
  await shoot('check-c-jump-button');

  const cIssues = [];
  if (replyCLines.length < 150) cIssues.push(`only ${replyCLines.length} numbered lines (expected ~200)`);
  if (!scrollMetrics) cIssues.push('no [data-chat-stream] container');
  else if (!scrollMetrics.atBottom) cIssues.push(`did NOT auto-stick to bottom (distance=${scrollMetrics.distanceFromBottom})`);
  if (afterScrollUp.scrollTop > 50) cIssues.push('scroll-to-top failed (user cannot scroll back)');
  if (cIssues.length === 0) {
    record('C', 'PASS', `Long output: ${replyCLines.length} numbered lines. Auto-stuck to bottom (dist=${scrollMetrics.distanceFromBottom}). User scrollback works. Jump-to-latest affordance: ${jumpBtnVisible ? 'present' : 'NOT detected'}.`);
  } else {
    record('C', cIssues.length >= 2 ? 'FAIL' : 'PARTIAL', cIssues.join('; '));
  }

  // ===== CHECK D: long markdown truncation / "show more" =====
  log('CHECK D: assistant block truncation/expand affordance');
  // Inspect last assistant block: is the full text rendered, or is there an
  // expand affordance?
  const truncate = await win.evaluate(() => {
    const all = document.querySelectorAll('[data-type-scale-role="assistant-body"]');
    const root = all[all.length - 1];
    if (!root) return { found: false, totalAssistantBlocksInDom: all.length };
    // Look for any "Show more / Show full / 展开 / 折叠" button-like element
    // inside the assistant block.
    const expandBtn = Array.from(root.querySelectorAll('button')).find((b) =>
      /show (more|full|less)|展开|折叠|更多|expand|collapse/i.test(b.textContent || b.getAttribute('aria-label') || '')
    );
    // Did the markdown body container clip with max-height + overflow?
    const candidates = Array.from(root.querySelectorAll('div'));
    let clipping = null;
    for (const d of candidates) {
      const cs = getComputedStyle(d);
      if ((cs.maxHeight !== 'none' && parseFloat(cs.maxHeight) > 0 && parseFloat(cs.maxHeight) < d.scrollHeight) || cs.overflowY === 'hidden') {
        clipping = { maxHeight: cs.maxHeight, overflowY: cs.overflowY, scrollHeight: d.scrollHeight, clientHeight: d.clientHeight };
        break;
      }
    }
    return {
      found: true,
      expandBtnText: expandBtn?.textContent?.slice(0, 80) ?? null,
      clipping,
      blockScrollHeight: root.scrollHeight,
      blockClientHeight: root.clientHeight
    };
  }, await getLastAssistantId());
  log('truncation analysis', truncate);
  await shoot('check-d-truncation');
  if (!truncate.found) {
    record('D', 'FAIL', 'No assistant block to inspect.');
  } else if (truncate.expandBtnText) {
    record('D', 'PASS', `Expand affordance present: "${truncate.expandBtnText}". Long output supports collapse.`);
  } else if (truncate.clipping) {
    record('D', 'PARTIAL', `Block is clipped (maxHeight=${truncate.clipping.maxHeight}, overflowY=${truncate.clipping.overflowY}) but no expand button found — content may be cut off without way to expand.`);
  } else {
    record('D', 'PARTIAL', 'No truncation/expand affordance for long markdown — full content rendered inline. Note: this is a feature gap if content is very long; may be intentional for chat UX. Outer chat container scrolls (Check C).');
  }

  // ===== CHECK E: mixed CJK+English =====
  log('CHECK E: mixed CJK + English');
  const promptE = 'summarize 这段内容: hello 世界 こんにちは';
  await sendPrompt(promptE);
  const replyE = await getLastAssistantText();
  await snapshotStore('check-e');
  await shoot('check-e-mixed');
  const eHasCjk = (replyE.match(/[一-鿿]/g) || []).length;
  const eHasJp = (replyE.match(/[぀-ヿ]/g) || []).length;
  const eHasEn = /[a-zA-Z]/.test(replyE);
  const eMojibake = replyE.includes('�');
  log('reply E (first 400):', replyE.slice(0, 400));
  if (replyE && !eMojibake && (eHasCjk > 0 || eHasJp > 0 || eHasEn)) {
    record('E', 'PASS', `Mixed-script reply OK. CJK=${eHasCjk} JP-kana=${eHasJp} hasLatin=${eHasEn} mojibake=${eMojibake}.`);
  } else if (!replyE) {
    record('E', 'FAIL', 'No reply for mixed-script prompt.');
  } else if (eMojibake) {
    record('E', 'FAIL', 'Mojibake detected in mixed-script reply.');
  } else {
    record('E', 'PARTIAL', `Mixed-script reply present but unusual: cjk=${eHasCjk} jp=${eHasJp} en=${eHasEn}.`);
  }

  // ===== CHECK F: 500-char single line =====
  log('CHECK F: 500-char single line');
  await sendPrompt("output a single line of 500 'a' characters with no spaces and no newlines, then stop.");
  const replyF = await getLastAssistantText();
  const fLastBlockId = await getLastAssistantId();
  await snapshotStore('check-f');
  // Find longest run of a's.
  const aMatch = replyF.match(/a{50,}/g) || [];
  const longestRun = aMatch.length ? Math.max(...aMatch.map((s) => s.length)) : 0;
  log(`reply F: longest run of 'a' = ${longestRun}, total length=${replyF.length}`);
  // Inspect overflow on the assistant block.
  const overflow = await win.evaluate(() => {
    const all = document.querySelectorAll('[data-type-scale-role="assistant-body"]');
    const root = all[all.length - 1];
    if (!root) return null;
    const stream = document.querySelector('[data-chat-stream]');
    const rb = root.getBoundingClientRect();
    const sb = stream?.getBoundingClientRect();
    const cs = getComputedStyle(root.querySelector('p') || root);
    return {
      blockWidth: rb.width,
      streamWidth: sb?.width ?? null,
      blockOverflowsStream: sb ? rb.right > sb.right + 2 : null,
      pWordBreak: cs.wordBreak,
      pOverflowWrap: cs.overflowWrap,
      pWhiteSpace: cs.whiteSpace,
      streamScrollWidth: stream?.scrollWidth ?? null,
      streamClientWidth: stream?.clientWidth ?? null,
      hasHorizontalOverflow: stream ? stream.scrollWidth > stream.clientWidth + 2 : null
    };
  }, fLastBlockId);
  log('check-f overflow analysis', overflow);
  await shoot('check-f-long-line');

  if (!overflow) {
    record('F', 'FAIL', 'No assistant block to inspect.');
  } else {
    const fIssues = [];
    if (overflow.blockOverflowsStream) fIssues.push(`block overflows stream by ${(overflow.blockWidth - overflow.streamWidth).toFixed(1)}px`);
    if (overflow.hasHorizontalOverflow) fIssues.push(`stream has horizontal overflow (scrollWidth=${overflow.streamScrollWidth} clientWidth=${overflow.streamClientWidth})`);
    if (longestRun < 200) fIssues.push(`only ${longestRun} consecutive 'a' chars (expected ~500) — model may have refused`);
    if (fIssues.length === 0) {
      record('F', 'PASS', `Long single-line wrapped cleanly. longest run=${longestRun}, wordBreak=${overflow.pWordBreak}, whiteSpace=${overflow.pWhiteSpace}, no horizontal overflow.`);
    } else if (fIssues.some((i) => /overflow/.test(i))) {
      record('F', 'FAIL', `Layout broken: ${fIssues.join('; ')}`);
    } else {
      record('F', 'PARTIAL', fIssues.join('; '));
    }
  }

  // Final snapshot
  await snapshotStore('final');
  await shoot('99-final');
} catch (e) {
  log('FATAL', String(e?.stack ?? e));
  try {
    if (win) await win.screenshot({ path: path.join(SHOTS_DIR, 'fatal-error.png') });
  } catch {}
} finally {
  fs.writeFileSync(path.join(LOG_DIR, 'findings.json'), JSON.stringify(findings, null, 2));
  log('=== FINDINGS ===');
  for (const [k, v] of Object.entries(findings)) log(`${k}: ${v.status} — ${v.detail}`);
  try {
    await app.close();
  } catch {}
}
