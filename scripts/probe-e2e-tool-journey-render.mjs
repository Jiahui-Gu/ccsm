// E2E user journey: tool call rendering + ANSI + error styling + truncation +
// toggle persistence + multi-tool independence.
//
// Methodology:
//   - Expectations are FROZEN before reading ChatStream/MessageBlock source.
//   - Each journey records {expected, observed, pass}; we report a matrix at
//     the end and exit non-zero if any journey failed.
//   - We do NOT spawn claude.exe; we mint MessageBlocks directly via the
//     zustand store (matches the existing probe-chatstream pattern). Frame
//     shape comes from src/types.ts (kind:'tool' has expanded/result/isError).
//
// Hard rules:
//   - Isolated userData (mkdtemp).
//   - No real Bash. No new deps.
//   - Strict assertions — if a journey "passes" trivially we treat it as a
//     coverage gap and mark it FAIL with a note.
//
// Run: `node scripts/probe-e2e-tool-journey-render.mjs`

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-tool-journey-'));
console.log(`[probe-e2e-tool-journey-render] userData = ${userDataDir}`);

const results = [];

function record(name, expected, observed, pass, note = '') {
  results.push({ name, expected, observed, pass, note });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}`);
  console.log(`  expected: ${expected}`);
  console.log(`  observed: ${observed}`);
  if (note) console.log(`  note: ${note}`);
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' },
});

let exitCode = 0;
try {
  const win = await appWindow(app, { timeout: 30_000 });
  win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__agentoryStore, null, { timeout: 20_000 });
  // Wait for sidebar to mount (seedStore precondition).
  await win.waitForFunction(() => !!document.querySelector('aside'), null, { timeout: 10_000 });

  // Helper: replace state with a fresh single-session fixture containing only
  // the blocks we want for this journey. Avoids cross-journey pollution.
  async function seed(blocks) {
    await win.evaluate(({ blocks }) => {
      const store = window.__agentoryStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{
          id: 's-tool',
          name: 'tool-journey',
          state: 'idle',
          cwd: 'C:/x',
          model: 'claude-opus-4',
          groupId: 'g1',
          agentType: 'claude-code',
        }],
        activeId: 's-tool',
        messagesBySession: { 's-tool': blocks },
        startedSessions: { 's-tool': true },
        runningSessions: {},
        messageQueues: {},
      });
    }, { blocks });
    await win.waitForTimeout(250);
  }

  // Locate the chat stream scroll container (last .flex-1.overflow-y-auto).
  function streamHandle() {
    return win.evaluateHandle(() => {
      const all = document.querySelectorAll('.flex-1.overflow-y-auto');
      return all[all.length - 1] ?? null;
    });
  }

  // ── Journey 1: toggle persistence across new frames ─────────────────────
  {
    await seed([
      { kind: 'user', id: 'u1', text: 'run a command' },
      { kind: 'tool', id: 't1', toolUseId: 'tu_1', name: 'Bash',
        brief: 'echo hi', expanded: false, result: 'hi-result-MARKER', isError: false },
    ]);

    // Find the tool block button. We pick buttons inside the stream that have
    // aria-expanded set.
    const toolBtns0 = await win.locator('main button[aria-expanded]').all();
    const initialExpanded = toolBtns0.length > 0
      ? await toolBtns0[0].getAttribute('aria-expanded')
      : '<no aria-expanded button>';

    // Click to toggle.
    if (toolBtns0.length === 0) {
      record('J1 toggle persists across new frames',
        'tool block button[aria-expanded] present and toggleable',
        `no button[aria-expanded] found in <main>`,
        false);
    } else {
      const btn = toolBtns0[0];
      await btn.click();
      await win.waitForTimeout(150);
      const afterClick = await btn.getAttribute('aria-expanded');
      const markerVisibleAfterClick = await win.evaluate(() =>
        document.body.innerText.includes('hi-result-MARKER'));

      // Now append a new assistant block — simulates a new frame from agent.
      await win.evaluate(() => {
        window.__agentoryStore.getState().appendBlocks('s-tool', [
          { kind: 'assistant', id: 'a-new', text: 'new turn after toggle' },
        ]);
      });
      await win.waitForTimeout(250);

      // Re-resolve the button (React may have re-rendered).
      const btnsAfter = await win.locator('main button[aria-expanded]').all();
      const afterFrame = btnsAfter.length > 0
        ? await btnsAfter[0].getAttribute('aria-expanded')
        : '<lost>';
      const markerVisibleAfterFrame = await win.evaluate(() =>
        document.body.innerText.includes('hi-result-MARKER'));

      const pass = (afterClick !== initialExpanded)
        && (afterFrame === afterClick)
        && (markerVisibleAfterFrame === markerVisibleAfterClick);

      record('J1 toggle persists across new frames',
        `aria-expanded toggles on click, and stays toggled (and marker stays ${markerVisibleAfterClick ? 'visible' : 'hidden'}) after appendBlocks`,
        `initial=${initialExpanded}, afterClick=${afterClick}, afterNewFrame=${afterFrame}, markerVisible afterClick=${markerVisibleAfterClick} afterFrame=${markerVisibleAfterFrame}`,
        pass);
    }
  }

  // ── Journey 2: ANSI color preservation ─────────────────────────────────
  {
    const ansi = '\x1b[31mERROR_TOKEN\x1b[0m and_then_plain';
    await seed([
      { kind: 'tool', id: 't2', toolUseId: 'tu_2', name: 'Bash',
        brief: 'fail', expanded: true, result: ansi, isError: false },
    ]);

    // Open the block in case expanded:true didn't auto-open.
    await win.evaluate(() => {
      const btns = document.querySelectorAll('main button[aria-expanded="false"]');
      btns.forEach((b) => b.click());
    });
    await win.waitForTimeout(200);

    const probe = await win.evaluate(() => {
      const text = document.body.innerText;
      const literalSeq = text.includes('\x1b[31m') || text.includes('[31m');
      // Look for any element whose textContent contains ERROR_TOKEN and inspect computed color.
      let errColor = null;
      let plainColor = null;
      const all = document.querySelectorAll('main *');
      for (const el of all) {
        if (!errColor && el.textContent === 'ERROR_TOKEN') {
          errColor = getComputedStyle(el).color;
        }
        if (!plainColor && el.textContent && el.textContent.trim() === 'and_then_plain') {
          plainColor = getComputedStyle(el).color;
        }
      }
      return { literalSeq, errColor, plainColor };
    });

    // Strict expectation: literal ANSI escape NOT in text; ERROR_TOKEN colored differently from plain.
    const literalOk = probe.literalSeq === false;
    const colorOk = probe.errColor && probe.plainColor && probe.errColor !== probe.plainColor;
    const pass = literalOk && colorOk;
    record('J2 ANSI color preserved (red applied, escape stripped)',
      'no literal "[31m" in DOM text AND ERROR_TOKEN computed color != plain text color',
      `literalSeq=${probe.literalSeq}, errColor=${probe.errColor}, plainColor=${probe.plainColor}`,
      pass,
      literalOk ? '' : 'literal ANSI escape leaked through to DOM text');
  }

  // ── Journey 3: ANSI cursor-move scrubbing ──────────────────────────────
  {
    const progress = 'progress 10%\n\x1b[1A\x1b[Kprogress 50%\n\x1b[1A\x1b[Kprogress 100%';
    await seed([
      { kind: 'tool', id: 't3', toolUseId: 'tu_3', name: 'Bash',
        brief: 'install', expanded: true, result: progress, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      const text = document.body.innerText;
      return {
        hasLiteralEsc: text.includes('\x1b[') || text.includes('\\x1b[') || /\[1A|\[K/.test(text),
        progress100Visible: text.includes('progress 100%'),
      };
    });
    const pass = !probe.hasLiteralEsc && probe.progress100Visible;
    record('J3 ANSI cursor-move scrubbed (no literal [1A/[K, latest line shown)',
      'no literal escape codes ("[1A"/"[K"/"\\x1b[") in DOM AND "progress 100%" still visible',
      `hasLiteralEsc=${probe.hasLiteralEsc}, progress100Visible=${probe.progress100Visible}`,
      pass,
      probe.hasLiteralEsc ? 'cursor-control escape leaked through to DOM' : '');
  }

  // ── Journey 4: long-output truncation + Show more ──────────────────────
  {
    // 5MB-ish: 50_000 lines × ~100 chars.
    const big = Array.from({ length: 50_000 }, (_, i) =>
      `line_${i.toString().padStart(6, '0')}_${'x'.repeat(80)}`).join('\n');
    await seed([
      { kind: 'tool', id: 't4', toolUseId: 'tu_4', name: 'Bash',
        brief: 'cat huge', expanded: true, result: big, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(500);
    const probe = await win.evaluate(() => {
      // Measure rendered text length inside the chat stream container.
      const all = document.querySelectorAll('.flex-1.overflow-y-auto');
      const stream = all[all.length - 1];
      if (!stream) return { error: 'no stream container' };
      const innerLen = stream.innerText.length;
      const html = stream.innerHTML;
      // Look for affordances.
      const text = stream.innerText.toLowerCase();
      const hasShowMore = /show more|more lines|show all|expand|truncated|\.\.\./i.test(text);
      // Last line index visible (proves whether full content is in DOM).
      const lastLineMatch = stream.innerText.match(/line_(\d{6})/g);
      const lastIdx = lastLineMatch ? lastLineMatch[lastLineMatch.length - 1] : null;
      return { innerLen, htmlLen: html.length, hasShowMore, lastLineSeen: lastIdx };
    });
    // Expect: rendered text bounded (< 200KB say), AND a Show more affordance exists.
    const bounded = typeof probe.innerLen === 'number' && probe.innerLen < 500_000;
    const pass = bounded && probe.hasShowMore;
    record('J4 long output truncated with Show more',
      'stream innerText < 500_000 chars AND truncation affordance ("show more"/"…"/"truncated"/"expand") present',
      `innerLen=${probe.innerLen}, htmlLen=${probe.htmlLen}, hasShowMore=${probe.hasShowMore}, lastLineSeen=${probe.lastLineSeen}`,
      pass,
      !bounded ? 'full 5MB output rendered to DOM — no truncation' :
        !probe.hasShowMore ? 'output may be silently cut without affordance' : '');
  }

  // ── Journey 5: tool error visual distinction ───────────────────────────
  {
    await seed([
      { kind: 'tool', id: 't5a', toolUseId: 'tu_5a', name: 'Bash',
        brief: 'ok', expanded: true, result: 'OK_RESULT_TOKEN', isError: false },
      { kind: 'tool', id: 't5b', toolUseId: 'tu_5b', name: 'Bash',
        brief: 'bad', expanded: true, result: 'ERR_RESULT_TOKEN', isError: true },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(200);

    const probe = await win.evaluate(() => {
      // Find the closest tool-block container for each marker. We walk up from
      // the text node until we hit something with aria-expanded or role-ish.
      function containerFor(marker) {
        const all = document.querySelectorAll('main *');
        for (const el of all) {
          if (el.children.length === 0 && el.textContent && el.textContent.includes(marker)) {
            // Walk up to the nearest button[aria-expanded] sibling's parent block.
            let cur = el;
            for (let i = 0; i < 12 && cur; i++) {
              if (cur.querySelector && cur.querySelector('button[aria-expanded]')) return cur;
              cur = cur.parentElement;
            }
            return el.parentElement;
          }
        }
        return null;
      }
      function snap(el) {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return {
          bg: cs.backgroundColor,
          color: cs.color,
          border: cs.borderColor,
          outline: cs.outlineColor,
          className: el.className && typeof el.className === 'string' ? el.className : '',
        };
      }
      const ok = containerFor('OK_RESULT_TOKEN');
      const err = containerFor('ERR_RESULT_TOKEN');
      return { ok: snap(ok), err: snap(err) };
    });

    const differs = probe.ok && probe.err && (
      probe.ok.bg !== probe.err.bg ||
      probe.ok.color !== probe.err.color ||
      probe.ok.border !== probe.err.border ||
      probe.ok.className !== probe.err.className
    );
    record('J5 tool error visually distinct from success',
      'error block container differs from success in backgroundColor / textColor / borderColor / className',
      `ok=${JSON.stringify(probe.ok)}, err=${JSON.stringify(probe.err)}`,
      !!differs,
      !differs ? 'success and error tool blocks render identically — user cannot tell them apart' : '');
  }

  // ── Journey 6: multi-tool serial — independent toggles ─────────────────
  {
    await seed([
      { kind: 'tool', id: 't6a', toolUseId: 'tu_6a', name: 'Bash',
        brief: 'ls', expanded: false, result: 'RESULT_A_TOKEN', isError: false },
      { kind: 'tool', id: 't6b', toolUseId: 'tu_6b', name: 'Read',
        brief: 'index.ts', expanded: false, result: 'RESULT_B_TOKEN', isError: false },
      { kind: 'tool', id: 't6c', toolUseId: 'tu_6c', name: 'Grep',
        brief: 'foo', expanded: false, result: 'RESULT_C_TOKEN', isError: false },
    ]);
    const btns = await win.locator('main button[aria-expanded]').all();
    if (btns.length < 3) {
      record('J6 multi-tool independent toggles',
        '3 tool blocks render as 3 independent button[aria-expanded]',
        `only ${btns.length} aria-expanded buttons found`,
        false);
    } else {
      // Toggle only the middle one.
      await btns[1].click();
      await win.waitForTimeout(200);
      const states = await Promise.all(btns.map((b) => b.getAttribute('aria-expanded')));
      const visibility = await win.evaluate(() => ({
        a: document.body.innerText.includes('RESULT_A_TOKEN'),
        b: document.body.innerText.includes('RESULT_B_TOKEN'),
        c: document.body.innerText.includes('RESULT_C_TOKEN'),
      }));
      const pass = states[0] === 'false' && states[1] === 'true' && states[2] === 'false'
        && !visibility.a && visibility.b && !visibility.c;
      record('J6 multi-tool independent toggles',
        'after toggling block #2 only: states=[false,true,false], result B visible, A and C hidden',
        `states=${JSON.stringify(states)}, visibility=${JSON.stringify(visibility)}`,
        pass,
        !pass ? 'toggle leaked across blocks OR collapsed body still leaks result text into DOM' : '');
    }
  }

  // ── summary matrix ──────────────────────────────────────────────────────
  console.log('\n=== consistency matrix ===');
  for (const r of results) {
    console.log(`  ${r.pass ? '[OK]' : '[XX]'} ${r.name}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== totals: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) exitCode = 1;
} catch (err) {
  console.error('[probe-e2e-tool-journey-render] threw:', err);
  exitCode = 1;
} finally {
  await app.close().catch(() => {});
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
