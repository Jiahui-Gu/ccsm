// Dogfood r2 fp13 — detail polish probe.
//
// Checks:
//   A. Long session name (80 chars) truncates with ellipsis + tooltip on hover.
//   B. cwd basename in sidebar (or anywhere visible). Sidebar shows session.name
//      not cwd, so this check inspects StatusBar cwd chip basename behavior.
//   C. Token usage display format (statusBar / sidebar).
//   D. Cost format after a small round-trip.
//   E. Status pill / Send-Stop morph + sidebar waiting indicator transitions.
//   F. Effort badge display + matches store.

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOTS_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp13-details');
const LOG_DIR = path.join(REPO_ROOT, 'dogfood-logs/r2-fp13');
fs.mkdirSync(SHOTS_DIR, { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });

const CCSM_EXE = 'C:\\Users\\jiahuigu\\AppData\\Local\\Programs\\CCSM\\CCSM.exe';
const USER_DATA = 'C:\\temp\\ccsm-dogfood-r2-fp13';
if (fs.existsSync(USER_DATA)) {
  fs.rmSync(USER_DATA, { recursive: true, force: true });
}
fs.mkdirSync(USER_DATA, { recursive: true });

// For Check B we want a known basename. Use C:\Users\jiahuigu (basename = "jiahuigu").
const PROBE_CWD = 'C:\\Users\\jiahuigu';

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
        text: typeof b.text === 'string' ? b.text.slice(0, 200) : undefined
      }));
      return {
        activeId: sid,
        sessions: (s.sessions || []).map((x) => ({ id: x.id, name: x.name, cwd: x.cwd })),
        running: !!s.runningSessions?.[sid],
        messageCount: msgs.length,
        statsCostUsd: s.sessionStats?.[sid]?.costUsd ?? null,
        statsTokensIn: s.sessionStats?.[sid]?.tokensIn ?? null,
        statsTokensOut: s.sessionStats?.[sid]?.tokensOut ?? null,
        contextUsage: s.contextUsageBySession?.[sid] ?? null,
        effortLevel: s.effortLevelBySession?.[sid] ?? s.globalEffortLevel ?? null,
        globalEffort: s.globalEffortLevel ?? null
      };
    });
    fs.writeFileSync(path.join(LOG_DIR, `snap-${label}.json`), JSON.stringify(snap, null, 2));
    log(`snap[${label}] count=${snap.messageCount} running=${snap.running}`);
    return snap;
  }

  async function ensureSession() {
    // createSession returns void; read activeId after.
    const sid = await win.evaluate(async (cwd) => {
      const st = window.__ccsmStore.getState();
      if (!st.activeId) {
        if (typeof st.createSession === 'function') st.createSession(cwd);
      }
      // Wait briefly for activeId to settle.
      for (let i = 0; i < 30; i++) {
        const id = window.__ccsmStore.getState().activeId;
        if (id) {
          const s2 = window.__ccsmStore.getState();
          const sess = (s2.sessions || []).find((x) => x.id === id);
          if (sess && (!sess.cwd || sess.cwd !== cwd)) {
            window.__ccsmStore.setState((cur) => ({
              sessions: cur.sessions.map((x) => (x.id === id ? { ...x, cwd } : x))
            }));
          }
          return id;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
      return null;
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
    log(`prompt settled in ${Date.now() - start}ms`);
  }

  // ===== CHECK A: long name truncate + tooltip =====
  log('CHECK A: long session name truncate + tooltip');
  const longName = 'A'.repeat(80);
  await win.evaluate(({ id, name }) => {
    const st = window.__ccsmStore.getState();
    if (typeof st.renameSession === 'function') {
      st.renameSession(id, name);
    } else {
      window.__ccsmStore.setState((cur) => ({
        sessions: cur.sessions.map((x) => (x.id === id ? { ...x, name } : x))
      }));
    }
  }, { id: sid, name: longName });
  await win.waitForTimeout(400);
  await shoot('check-a-long-name-rendered');

  const truncInfo = await win.evaluate((targetId) => {
    // Find sidebar entry for the active session by matching name text.
    const candidates = Array.from(document.querySelectorAll('span.truncate, [data-session-id], [data-session-row]'));
    const longName = 'A'.repeat(80);
    let entry = null;
    for (const el of candidates) {
      if (el.textContent && el.textContent.includes(longName.slice(0, 40))) {
        entry = el;
        break;
      }
    }
    if (!entry) {
      // Fallback: any element whose text includes 30 consecutive A's
      const all = Array.from(document.querySelectorAll('span'));
      for (const el of all) {
        if (el.textContent && /A{30,}/.test(el.textContent)) {
          entry = el;
          break;
        }
      }
    }
    if (!entry) return { found: false };
    const cs = getComputedStyle(entry);
    const rect = entry.getBoundingClientRect();
    // walk up to find an element with title or data-tooltip / aria-label
    let cur = entry;
    let tooltipSrc = null;
    for (let i = 0; i < 6 && cur; i++) {
      const t = cur.getAttribute('title');
      const al = cur.getAttribute('aria-label');
      const dt = cur.getAttribute('data-tooltip') || cur.getAttribute('data-tooltip-content');
      if (t) { tooltipSrc = { kind: 'title', value: t, level: i }; break; }
      if (al && al.length > 30) { tooltipSrc = { kind: 'aria-label', value: al, level: i }; break; }
      if (dt) { tooltipSrc = { kind: 'data-tooltip', value: dt, level: i }; break; }
      cur = cur.parentElement;
    }
    return {
      found: true,
      tag: entry.tagName,
      class: entry.className,
      textOverflow: cs.textOverflow,
      whiteSpace: cs.whiteSpace,
      overflow: cs.overflow,
      width: rect.width,
      scrollWidth: entry.scrollWidth,
      clientWidth: entry.clientWidth,
      clipped: entry.scrollWidth > entry.clientWidth + 2,
      visibleText: entry.textContent.slice(0, 100),
      fullText: entry.textContent,
      tooltipSrc
    };
  }, sid);
  log('check-a truncInfo', truncInfo);
  fs.writeFileSync(path.join(LOG_DIR, 'check-a-trunc.json'), JSON.stringify(truncInfo, null, 2));

  // Hover test — try to surface a Radix tooltip
  if (truncInfo.found) {
    try {
      const handle = await win.evaluateHandle(() => {
        const all = Array.from(document.querySelectorAll('span'));
        for (const el of all) {
          if (el.textContent && /A{30,}/.test(el.textContent)) return el;
        }
        return null;
      });
      const elt = handle.asElement();
      if (elt) {
        await elt.hover().catch(() => {});
        await win.waitForTimeout(900);
        await shoot('check-a-hover-tooltip');
        const tooltipDom = await win.evaluate(() => {
          const tt = Array.from(document.querySelectorAll('[role="tooltip"], [data-radix-tooltip-content], [data-side]'));
          return tt.map((el) => ({
            role: el.getAttribute('role'),
            text: el.textContent?.slice(0, 200) ?? null,
            visible: el.offsetParent !== null
          })).filter((x) => x.text);
        });
        log('check-a tooltipDom', tooltipDom);
        fs.writeFileSync(path.join(LOG_DIR, 'check-a-tooltip-dom.json'), JSON.stringify(tooltipDom, null, 2));
        truncInfo.tooltipDom = tooltipDom;
      }
    } catch (e) {
      log('check-a hover error', String(e));
    }
  }

  if (!truncInfo.found) {
    record('A', 'FAIL', 'Could not locate sidebar entry for the renamed session.');
  } else {
    const issues = [];
    if (!truncInfo.clipped) issues.push(`text NOT clipped (scrollW=${truncInfo.scrollWidth} clientW=${truncInfo.clientWidth})`);
    if (truncInfo.textOverflow !== 'ellipsis') issues.push(`text-overflow=${truncInfo.textOverflow} (expect ellipsis)`);
    if (!/nowrap/.test(truncInfo.whiteSpace)) issues.push(`white-space=${truncInfo.whiteSpace} (expect nowrap)`);
    const hoverTooltipText = (truncInfo.tooltipDom || []).map((t) => t.text || '').join(' ');
    const hoverHasFullName = hoverTooltipText.includes('A'.repeat(40));
    const titleHasFullName = truncInfo.tooltipSrc?.value && truncInfo.tooltipSrc.value.includes('A'.repeat(40));
    if (!hoverHasFullName && !titleHasFullName) {
      issues.push(`no tooltip / title attr surfaces full name on hover (tooltipSrc=${JSON.stringify(truncInfo.tooltipSrc)})`);
    }
    if (issues.length === 0) {
      record('A', 'PASS', `truncate ellipsis + hover tooltip both work. visibleText="${truncInfo.visibleText.slice(0, 30)}..." tooltip via ${truncInfo.tooltipSrc?.kind ?? 'hover'}.`);
    } else if (issues.length === 1 && issues[0].startsWith('no tooltip')) {
      record('A', 'PARTIAL', `truncate works (ellipsis), but ${issues[0]}.`);
    } else {
      record('A', 'FAIL', issues.join('; '));
    }
  }

  // Reset name to a short value so subsequent screenshots are sane.
  await win.evaluate((id) => {
    const st = window.__ccsmStore.getState();
    if (typeof st.renameSession === 'function') st.renameSession(id, 'fp13 probe');
  }, sid);
  await win.waitForTimeout(300);

  // ===== CHECK B: cwd basename =====
  log('CHECK B: cwd basename');
  // Re-read active session — the prompt below populates it if not already.
  const cwdInfo = await win.evaluate(() => {
    const st = window.__ccsmStore.getState();
    const id = st.activeId;
    const sess = (st.sessions || []).find((x) => x.id === id);
    const storedCwd = sess?.cwd || null;
    const cwdBasenameWin = (storedCwd || '').split(/[\\/]/).filter(Boolean).pop() || '';
    function findText(needle) {
      if (!needle) return [];
      const all = Array.from(document.querySelectorAll('button, span, div'));
      const matches = [];
      for (const el of all) {
        if (el.children.length === 0 && el.textContent && el.textContent.includes(needle)) {
          const rect = el.getBoundingClientRect();
          if (rect.width > 0) {
            matches.push({
              tag: el.tagName,
              text: el.textContent.slice(0, 120),
              title: el.getAttribute('title'),
              aria: el.getAttribute('aria-label'),
              parentClass: el.parentElement?.className?.slice?.(0, 80) ?? null
            });
          }
        }
      }
      return matches.slice(0, 8);
    }
    return {
      storedCwd,
      basename: cwdBasenameWin,
      basenameMatches: findText(cwdBasenameWin),
      fullPathMatches: findText(storedCwd && storedCwd.length > 5 ? storedCwd : '___NEVER___')
    };
  });
  log('check-b cwdInfo', cwdInfo);
  fs.writeFileSync(path.join(LOG_DIR, 'check-b-cwd.json'), JSON.stringify(cwdInfo, null, 2));
  await shoot('check-b-cwd-display');

  if (!cwdInfo.storedCwd) {
    record('B', 'FAIL', 'No cwd stored on session.');
  } else if (cwdInfo.basenameMatches.length > 0 && cwdInfo.fullPathMatches.length === 0) {
    record('B', 'PASS', `cwd shown as basename "${cwdInfo.basename}" (${cwdInfo.basenameMatches.length} match(es)). Full path NOT visible directly.`);
  } else if (cwdInfo.basenameMatches.length > 0 && cwdInfo.fullPathMatches.length > 0) {
    record('B', 'PARTIAL', `Basename "${cwdInfo.basename}" visible AND full path "${cwdInfo.storedCwd}" also rendered somewhere — basename-only display would be cleaner.`);
  } else if (cwdInfo.fullPathMatches.length > 0) {
    record('B', 'FAIL', `Full path "${cwdInfo.storedCwd}" rendered instead of basename "${cwdInfo.basename}".`);
  } else {
    record('B', 'PARTIAL', `Neither basename nor full path visible directly — cwd may be hidden behind chip click.`);
  }

  // ===== Send a small prompt for token / cost / status data =====
  log('Sending small prompt to populate stats');
  const t0 = Date.now();
  // Capture during-running screenshot via sentinel in background
  let runningCaptureDone = false;
  (async () => {
    for (let i = 0; i < 60 && !runningCaptureDone; i++) {
      const isRunning = await win.evaluate(() => {
        const s = window.__ccsmStore.getState();
        return !!s.runningSessions?.[s.activeId];
      }).catch(() => false);
      if (isRunning) {
        await shoot('check-e-running-state').catch(() => {});
        runningCaptureDone = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  })();

  await sendPrompt('please respond with exactly: hello fp13');
  log(`small prompt elapsed ${Date.now() - t0}ms`);
  runningCaptureDone = true;

  await win.waitForTimeout(600);
  const snapAfter = await snapshotStore('after-roundtrip-1');
  await shoot('check-cd-after-roundtrip');

  // ===== CHECK C: token usage display =====
  log('CHECK C: token usage display');
  const ctxChip = await win.evaluate(() => {
    const chip = document.querySelector('[data-testid="context-pie-chip"]');
    if (!chip) return { found: false };
    const sr = chip.querySelector('.sr-only');
    const tooltip = chip.getAttribute('aria-label');
    return {
      found: true,
      visibleText: chip.textContent?.trim() ?? '',
      srText: sr?.textContent?.trim() ?? '',
      ariaLabel: tooltip,
      title: chip.getAttribute('title')
    };
  });
  log('check-c ctxChip', ctxChip);
  // Also look elsewhere for "tokens" text.
  const tokenMentions = await win.evaluate(() => {
    const re = /\b(\d+(?:\.\d+)?[kKmM]?)\s*\/\s*(\d+(?:\.\d+)?[kKmM]?)\b/;
    const all = Array.from(document.querySelectorAll('button, span, div'));
    const out = [];
    for (const el of all) {
      if (el.children.length === 0 && el.textContent) {
        const m = el.textContent.match(re);
        if (m) out.push({ text: el.textContent.trim().slice(0, 80), tag: el.tagName });
      }
    }
    return out.slice(0, 10);
  });
  log('check-c tokenMentions', tokenMentions);
  fs.writeFileSync(path.join(LOG_DIR, 'check-c-tokens.json'), JSON.stringify({ ctxChip, tokenMentions, snapContext: snapAfter.contextUsage }, null, 2));

  // Per StatusBar.tsx the context chip is intentionally hidden until usage
  // reaches >= 50% of the window. With a 1M-token window and only 1 small
  // round-trip, we'll be at ~3-4% and the chip is hidden by design.
  const usagePct = snapAfter.contextUsage && snapAfter.contextUsage.contextWindow
    ? (snapAfter.contextUsage.totalTokens / snapAfter.contextUsage.contextWindow) * 100
    : 0;
  if (snapAfter.contextUsage && ctxChip.found) {
    record('C', 'PASS', `Context chip rendered. visible="${ctxChip.visibleText}" sr="${ctxChip.srText}" aria="${ctxChip.ariaLabel}". formatTokens uses k/M abbreviations (e.g. "35.8k / 1.0M"). Usage=${usagePct.toFixed(1)}%.`);
  } else if (snapAfter.contextUsage && usagePct < 50) {
    record('C', 'PARTIAL', `Context chip is hidden by design until usage >= 50% (current ${usagePct.toFixed(1)}%, ${snapAfter.contextUsage.totalTokens} / ${snapAfter.contextUsage.contextWindow}). Token usage IS captured in store but invisible to the user at low fill. Consider always-visible compact display or a lower threshold.`);
  } else if (!snapAfter.contextUsage) {
    record('C', 'PARTIAL', 'contextUsage not yet populated after 1 round-trip.');
  } else {
    record('C', 'FAIL', `contextUsage in store (${usagePct.toFixed(1)}%) but no chip element found.`);
  }

  // ===== CHECK D: cost format =====
  log('CHECK D: cost format');
  const costMentions = await win.evaluate(() => {
    const all = Array.from(document.querySelectorAll('button, span, div'));
    const out = [];
    for (const el of all) {
      if (el.children.length === 0 && el.textContent) {
        const t = el.textContent;
        if (/\$\s*\d/.test(t) || /\d+\.\d+\s*USD/.test(t) || /cost/i.test(t)) {
          out.push({ text: t.trim().slice(0, 120), tag: el.tagName });
        }
      }
    }
    return out.slice(0, 15);
  });
  log('check-d costMentions', costMentions);
  fs.writeFileSync(path.join(LOG_DIR, 'check-d-cost.json'), JSON.stringify({ costMentions, statsCostUsd: snapAfter.statsCostUsd }, null, 2));

  if (snapAfter.statsCostUsd && snapAfter.statsCostUsd > 0) {
    const dollarMatches = costMentions.filter((m) => /\$\s*\d/.test(m.text));
    if (dollarMatches.length > 0) {
      record('D', 'PASS', `Cost shown: ${dollarMatches.map((m) => '"' + m.text + '"').join(', ')}. Store costUsd=${snapAfter.statsCostUsd}.`);
    } else {
      record('D', 'FAIL', `Store has costUsd=${snapAfter.statsCostUsd} but NO cost surfaces in UI. Per stream-to-blocks.ts the result-stats footer is currently disabled (resultBlocks returns []). Cost is tracked but invisible to the user.`);
    }
  } else {
    record('D', 'PARTIAL', `Store costUsd=${snapAfter.statsCostUsd} (null or 0) — proxy may not be reporting cost. Cannot verify display format.`);
  }

  // ===== CHECK E: status pill / send-stop morph =====
  log('CHECK E: send-stop morph + sidebar waiting indicator');
  // We already captured running state in the background above. Now capture idle.
  await shoot('check-e-idle-state');

  // Read the current send/stop button morph state.
  const morphIdle = await win.evaluate(() => {
    const btn = document.querySelector('[data-morph-state]');
    if (!btn) return { found: false };
    const cs = getComputedStyle(btn);
    return {
      found: true,
      morphState: btn.getAttribute('data-morph-state'),
      ariaLabel: btn.getAttribute('aria-label'),
      backgroundColor: cs.backgroundColor,
      color: cs.color,
      text: btn.textContent?.trim() ?? '',
      disabled: btn.hasAttribute('disabled') || btn.getAttribute('aria-disabled') === 'true'
    };
  });
  log('check-e morphIdle', morphIdle);

  // Trigger another prompt and capture during-streaming pill.
  let streamingMorph = null;
  let sidebarWaiting = null;
  const promptText = 'count from 1 to 8 one per line, no commentary';
  log('sending streaming prompt');
  const ta = win.locator('textarea[data-input-bar]').first();
  await ta.click();
  await ta.fill(promptText);
  await win.waitForTimeout(150);
  await win.keyboard.press('Enter');

  // Poll for running and capture state.
  for (let i = 0; i < 80; i++) {
    const now = await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      const running = !!s.runningSessions?.[s.activeId];
      const btn = document.querySelector('[data-morph-state]');
      const morph = btn ? {
        morphState: btn.getAttribute('data-morph-state'),
        ariaLabel: btn.getAttribute('aria-label'),
        bg: getComputedStyle(btn).backgroundColor
      } : null;
      // sidebar waiting indicator: GroupRow renders a span with aria-label sidebar.waitingForResponse
      const waiting = document.querySelector('[aria-label*="aiting"], [aria-label*="等待"], [aria-label*="responding"]');
      const waitingInfo = waiting ? {
        ariaLabel: waiting.getAttribute('aria-label'),
        visible: waiting.offsetParent !== null,
        bg: getComputedStyle(waiting).backgroundColor
      } : null;
      return { running, morph, waitingInfo };
    });
    if (now.running && now.morph?.morphState === 'stop') {
      streamingMorph = now.morph;
      sidebarWaiting = now.waitingInfo;
      await shoot('check-e-streaming-state');
      break;
    }
    await win.waitForTimeout(150);
  }
  log('check-e streamingMorph', streamingMorph);
  log('check-e sidebarWaiting', sidebarWaiting);

  // Wait for completion
  for (let i = 0; i < 200; i++) {
    const r = await win.evaluate(() => !!window.__ccsmStore.getState().runningSessions?.[window.__ccsmStore.getState().activeId]);
    if (!r) break;
    await win.waitForTimeout(300);
  }
  await win.waitForTimeout(500);
  const morphAfter = await win.evaluate(() => {
    const btn = document.querySelector('[data-morph-state]');
    return btn ? {
      morphState: btn.getAttribute('data-morph-state'),
      ariaLabel: btn.getAttribute('aria-label'),
      bg: getComputedStyle(btn).backgroundColor
    } : null;
  });
  log('check-e morphAfter', morphAfter);
  await shoot('check-e-after-stream');

  fs.writeFileSync(path.join(LOG_DIR, 'check-e-states.json'), JSON.stringify({ morphIdle, streamingMorph, morphAfter, sidebarWaiting }, null, 2));

  const eIssues = [];
  if (!morphIdle.found) eIssues.push('no [data-morph-state] button found');
  if (!streamingMorph) eIssues.push('never captured streaming state (data-morph-state=stop)');
  if (streamingMorph && morphAfter && streamingMorph.bg === morphAfter.bg) eIssues.push(`streaming and idle bg colors identical (${streamingMorph.bg}) — not visually distinct`);
  if (morphIdle.found && morphIdle.ariaLabel && /[\?\u{FFFD}]/u.test(morphIdle.ariaLabel)) eIssues.push('mojibake in aria-label');
  if (eIssues.length === 0) {
    record('E', 'PASS', `Send/Stop morph transitions: idle aria="${morphIdle.ariaLabel}" bg=${morphIdle.backgroundColor}; streaming aria="${streamingMorph.ariaLabel}" bg=${streamingMorph.bg}; back to ${morphAfter.morphState} bg=${morphAfter.bg}. ${sidebarWaiting ? `Sidebar waiting indicator: ${sidebarWaiting.ariaLabel}.` : 'No separate sidebar waiting indicator surfaced.'}`);
  } else if (eIssues.length === 1 && eIssues[0].startsWith('never captured')) {
    record('E', 'PARTIAL', `Streaming state capture missed (timing). Idle: ${JSON.stringify(morphIdle)}.`);
  } else {
    record('E', 'FAIL', eIssues.join('; '));
  }

  // ===== CHECK F: effort badge =====
  log('CHECK F: effort badge');
  const effortInfo = await win.evaluate(() => {
    // Query the StatusBar effort chip directly via data-testid.
    const effortChip = document.querySelector('[data-testid="effort-chip"]');
    if (!effortChip) return { found: false };
    const rect = effortChip.getBoundingClientRect();
    return {
      found: true,
      text: (effortChip.textContent || '').trim(),
      ariaLabel: effortChip.getAttribute('aria-label'),
      title: effortChip.getAttribute('title'),
      visible: rect.width > 0 && rect.height > 0,
      // also enumerate other chips alongside for context
      siblings: Array.from(document.querySelectorAll('[data-testid$="-chip"], button[data-testid]')).map((b) => ({
        testid: b.getAttribute('data-testid'),
        text: (b.textContent || '').trim().slice(0, 40)
      }))
    };
  });
  log('check-f effortInfo', effortInfo);
  await shoot('check-f-effort-badge-default');
  fs.writeFileSync(path.join(LOG_DIR, 'check-f-effort.json'), JSON.stringify({ effortInfo, storeEffort: snapAfter.effortLevel, globalEffort: snapAfter.globalEffort }, null, 2));

  // Open the effort menu, list options.
  let cycleResult = null;
  try {
    if (effortInfo.found) {
      const handle = await win.evaluateHandle(() => document.querySelector('[data-testid="effort-chip"]'));
      const elt = handle.asElement();
      if (elt) {
        await elt.click();
        await win.waitForTimeout(500);
        await shoot('check-f-effort-menu-open');
        const menuItems = await win.evaluate(() => {
          const items = Array.from(document.querySelectorAll('[role="menuitem"], [data-radix-collection-item]'));
          return items.map((el) => (el.textContent || '').trim().slice(0, 80)).filter((x) => x);
        });
        log('check-f menuItems', menuItems);
        cycleResult = { menuItems };
        await win.keyboard.press('Escape');
        await win.waitForTimeout(300);
      }
    }
  } catch (e) {
    log('check-f cycle error', String(e));
  }

  if (effortInfo.found && snapAfter.effortLevel) {
    const labelLower = effortInfo.text.toLowerCase();
    const storeLower = String(snapAfter.effortLevel).toLowerCase();
    const matches = labelLower.includes(storeLower) || (storeLower === 'high' && /^(high|deep|standard)/i.test(labelLower));
    if (matches) {
      record('F', 'PASS', `Effort chip visible: "${effortInfo.text}" (title="${effortInfo.title}"). Matches store effortLevel=${snapAfter.effortLevel}. Picker has ${cycleResult?.menuItems?.length ?? '?'} options: ${JSON.stringify(cycleResult?.menuItems ?? []).slice(0, 200)}.`);
    } else {
      record('F', 'PARTIAL', `Effort chip visible ("${effortInfo.text}") but does not literally match store value (${snapAfter.effortLevel}). Could be a localized alias.`);
    }
  } else if (effortInfo.found) {
    record('F', 'PARTIAL', `Effort chip visible ("${effortInfo.text}") but store effortLevel not populated.`);
  } else {
    record('F', 'FAIL', 'No [data-testid="effort-chip"] found in input bar.');
  }

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
  for (const [k, v] of Object.entries(findings)) log(`${k}: ${v.status} - ${v.detail}`);
  try {
    await app.close();
  } catch {}
}
