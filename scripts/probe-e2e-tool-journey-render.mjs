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
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-tool-journey-'));
console.log(`[probe-e2e-tool-journey-render] userData = ${userDataDir}`);

// Serve OUR worktree's freshly-built dist/renderer so we never read a stale
// dev server bound elsewhere. `npm run build` (or at least `webpack --mode
// production`) must have run first; we surface a friendly error if not.
const { port: PORT, close: closeServer } = await startBundleServer(root);

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
  env: { ...process.env, NODE_ENV: 'development', CCSM_DEV_PORT: String(PORT) },
});

let exitCode = 0;
try {
  const win = await appWindow(app, { timeout: 30_000 });
  win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
  // Wait for sidebar to mount (seedStore precondition).
  await win.waitForFunction(() => !!document.querySelector('aside'), null, { timeout: 10_000 });

  // Helper: replace state with a fresh single-session fixture containing only
  // the blocks we want for this journey. Avoids cross-journey pollution.
  async function seed(blocks) {
    await win.evaluate(({ blocks }) => {
      const store = window.__ccsmStore;
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
        window.__ccsmStore.getState().appendBlocks('s-tool', [
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
  // Uses a non-shell tool ('Read') so the LongOutputView path is exercised.
  // Bash output is owned by xterm/Terminal (its own capping rules); this
  // journey targets the raw-text tool branch (Read/Grep/etc.).
  {
    // 50_000 lines of ~100 chars ≈ 5MB total (under MAX_INLINE_BYTES=10MB).
    const LINES = 50_000;
    const big = Array.from({ length: LINES }, (_, i) =>
      `line_${i.toString().padStart(6, '0')}_${'x'.repeat(80)}`).join('\n');
    await seed([
      { kind: 'tool', id: 't4', toolUseId: 'tu_4', name: 'Read',
        brief: 'huge.log', expanded: true, result: big, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(400);

    // ── 4a: collapsed default — head + separator + tail ────────────────
    const collapsedProbe = await win.evaluate(({ HEAD, TAIL, LINES }) => {
      const head = document.querySelector('[data-testid="tool-output-collapsed-head"]');
      const tail = document.querySelector('[data-testid="tool-output-collapsed-tail"]');
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      const copyBtn = document.querySelector('[data-testid="tool-output-copy"]');
      const saveBtn = document.querySelector('[data-testid="tool-output-save"]');
      const expandBtn = document.querySelector('[data-testid="tool-output-expand"]');
      // Count line tokens visible.
      const all = document.querySelectorAll('.flex-1.overflow-y-auto');
      const stream = all[all.length - 1];
      const matches = stream ? stream.innerText.match(/line_(\d{6})/g) ?? [] : [];
      const indices = matches.map((m) => parseInt(m.slice(5), 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      const expectedHidden = LINES - HEAD - TAIL;
      const sepText = sep ? sep.textContent ?? '' : '';
      const sepHasCount = sepText.includes(String(expectedHidden));
      return {
        hasHead: !!head,
        hasTail: !!tail,
        hasSeparator: !!sep,
        sepText: sepText.slice(0, 120),
        sepHasCount,
        hasCopyBtn: !!copyBtn,
        hasSaveBtn: !!saveBtn,
        hasExpandBtn: !!expandBtn,
        firstLineSeen: min,
        lastLineSeen: max,
        visibleLineCount: indices.length,
        streamInnerLen: stream ? stream.innerText.length : 0,
      };
    }, { HEAD: 50, TAIL: 50, LINES });

    const collapsedPass =
      collapsedProbe.hasHead &&
      collapsedProbe.hasTail &&
      collapsedProbe.hasSeparator &&
      collapsedProbe.sepHasCount &&
      collapsedProbe.hasCopyBtn &&
      collapsedProbe.hasSaveBtn &&
      collapsedProbe.hasExpandBtn &&
      collapsedProbe.firstLineSeen === 0 &&
      collapsedProbe.lastLineSeen === LINES - 1 &&
      // ~50 + ~50 lines, plus a few elsewhere — should be < 200.
      collapsedProbe.visibleLineCount <= 120 &&
      collapsedProbe.streamInnerLen < 50_000;
    record('J4a long output collapsed (head + separator + tail + toolbar)',
      `head[0..49] AND tail[${LINES - 50}..${LINES - 1}] visible AND separator with hidden count (${LINES - 100}) AND Copy/Save/Expand buttons present AND total visible lines <= ~100`,
      JSON.stringify(collapsedProbe),
      collapsedPass);

    // ── 4b: click expand → virtualized window mounts only a slice ──────
    await win.evaluate(() => {
      document.querySelector('[data-testid="tool-output-expand"]')?.click();
    });
    await win.waitForTimeout(300);
    const expandedProbe = await win.evaluate(() => {
      const viewport = document.querySelector('[data-testid="tool-output-viewport"]');
      const spacer = document.querySelector('[data-testid="tool-output-spacer"]');
      if (!viewport || !spacer) return { error: 'no viewport/spacer' };
      const lineEls = spacer.querySelectorAll('[data-line-index]');
      const indices = Array.from(lineEls)
        .map((el) => parseInt(el.getAttribute('data-line-index') ?? '-1', 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      const spacerH = spacer.getBoundingClientRect().height;
      return {
        mountedLineCount: indices.length,
        firstMountedIdx: min,
        lastMountedIdx: max,
        spacerHeightPx: spacerH,
        viewportInnerLen: viewport.innerText.length,
      };
    });
    const expandedPass =
      typeof expandedProbe.mountedLineCount === 'number' &&
      expandedProbe.mountedLineCount > 0 &&
      expandedProbe.mountedLineCount < 1000 &&
      expandedProbe.firstMountedIdx === 0 &&
      expandedProbe.lastMountedIdx < 1000 &&
      typeof expandedProbe.spacerHeightPx === 'number' &&
      expandedProbe.spacerHeightPx > 100_000;
    record('J4b expanded virtualizes (mounts < 1000 lines, spacer covers full height)',
      'mounted between 1 and 1000 line elements; first=0; spacer height > 100_000px (proves not all 50k DOM nodes)',
      JSON.stringify(expandedProbe),
      expandedPass);

    // ── 4c: scroll to bottom → far-end lines mount, top unmounts ────────
    await win.evaluate(() => {
      const v = document.querySelector('[data-testid="tool-output-viewport"]');
      if (v) v.scrollTop = v.scrollHeight;
    });
    await win.waitForTimeout(250);
    const scrolledProbe = await win.evaluate(({ LINES }) => {
      const spacer = document.querySelector('[data-testid="tool-output-spacer"]');
      if (!spacer) return { error: 'no spacer' };
      const indices = Array.from(spacer.querySelectorAll('[data-line-index]'))
        .map((el) => parseInt(el.getAttribute('data-line-index') ?? '-1', 10));
      const min = indices.length ? Math.min(...indices) : -1;
      const max = indices.length ? Math.max(...indices) : -1;
      return {
        mountedLineCount: indices.length,
        firstMountedIdx: min,
        lastMountedIdx: max,
        sawLastLine: max === LINES - 1,
      };
    }, { LINES });
    const scrolledPass =
      typeof scrolledProbe.mountedLineCount === 'number' &&
      scrolledProbe.mountedLineCount < 1000 &&
      scrolledProbe.sawLastLine === true &&
      scrolledProbe.firstMountedIdx > LINES - 1000;
    record('J4c expanded scroll-to-end mounts tail, drops head',
      `after scroll-to-bottom: last mounted = ${LINES - 1} AND first mounted > ${LINES - 1000} AND mounted count < 1000`,
      JSON.stringify(scrolledProbe),
      scrolledPass);

    // ── 4d: collapse round-trips back to head/tail view ─────────────────
    await win.evaluate(() => {
      document.querySelector('[data-testid="tool-output-expand"]')?.click();
    });
    await win.waitForTimeout(200);
    const reCollapsed = await win.evaluate(() => ({
      hasHead: !!document.querySelector('[data-testid="tool-output-collapsed-head"]'),
      hasViewport: !!document.querySelector('[data-testid="tool-output-viewport"]'),
    }));
    record('J4d collapse round-trips back to head/tail view',
      'hasHead=true, hasViewport=false',
      JSON.stringify(reCollapsed),
      reCollapsed.hasHead && !reCollapsed.hasViewport);
  }

  // ── Journey 4-extreme: >10MB forces user to Save as .log ───────────────
  {
    const HUGE_LINES = 110_000;
    const huge = Array.from({ length: HUGE_LINES }, (_, i) =>
      `xline_${i.toString().padStart(6, '0')}_${'x'.repeat(100)}`).join('\n');
    await seed([
      { kind: 'tool', id: 't4x', toolUseId: 'tu_4x', name: 'Read',
        brief: 'mega.log', expanded: true, result: huge, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(500);
    const xprobe = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-expand"]');
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      const save = document.querySelector('[data-testid="tool-output-save"]');
      return {
        expandDisabled: btn ? btn.hasAttribute('disabled') : null,
        sepDisabled: sep ? sep.hasAttribute('disabled') : null,
        hasSave: !!save,
        expandTitle: btn ? btn.getAttribute('title') ?? '' : '',
      };
    });
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-expand"]');
      if (btn && !btn.hasAttribute('disabled')) btn.click();
      const sep = document.querySelector('[data-testid="tool-output-separator"]');
      if (sep && !sep.hasAttribute('disabled')) sep.click();
    });
    await win.waitForTimeout(200);
    const stillNoViewport = await win.evaluate(() =>
      !document.querySelector('[data-testid="tool-output-viewport"]'));
    const pass =
      xprobe.expandDisabled === true &&
      xprobe.sepDisabled === true &&
      xprobe.hasSave === true &&
      stillNoViewport === true;
    record('J4-extreme >10MB blocks inline expand, Save still available',
      'Expand button disabled, separator disabled, Save button still present, clicking either does NOT mount viewport',
      `${JSON.stringify(xprobe)}, stillNoViewport=${stillNoViewport}`,
      pass,
      !pass ? 'oversized output can still be force-expanded → renderer at risk' : '');
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

  // ── Journey 5b: tool error auto-expands by default (#304) ────────────
  // Regression guard: an `isError:true` tool block must render with
  // aria-expanded="true" without any user click — the user shouldn't have
  // to hunt for the chevron to see why the tool failed. Reverse-verify:
  // strip the auto-expand effect from ToolBlock.tsx and this case must
  // fail (button starts as aria-expanded="false").
  {
    await seed([
      { kind: 'tool', id: 't5c', toolUseId: 'tu_5c', name: 'Bash',
        brief: 'fail-auto', expanded: false,
        result: 'AUTO_EXPAND_ERR_TOKEN', isError: true },
      { kind: 'tool', id: 't5d', toolUseId: 'tu_5d', name: 'Bash',
        brief: 'ok-auto', expanded: false,
        result: 'AUTO_EXPAND_OK_TOKEN', isError: false },
    ]);
    // Do NOT click anything — that's the whole point of the test.
    await win.waitForTimeout(200);
    const probe = await win.evaluate(() => {
      const btns = Array.from(document.querySelectorAll('main button[aria-expanded]'));
      // Find the button whose row contains our tokens.
      function find(token) {
        for (const b of btns) {
          // Walk up to the block container, then check its text body.
          let cur = b.parentElement;
          for (let i = 0; i < 6 && cur; i++) {
            if (cur.textContent && cur.textContent.includes(token)) return b;
            cur = cur.parentElement;
          }
        }
        return null;
      }
      const errBtn = find('fail-auto');
      const okBtn = find('ok-auto');
      return {
        errExpanded: errBtn ? errBtn.getAttribute('aria-expanded') : null,
        okExpanded: okBtn ? okBtn.getAttribute('aria-expanded') : null,
        errBodyVisible: document.body.innerText.includes('AUTO_EXPAND_ERR_TOKEN'),
        okBodyVisible: document.body.innerText.includes('AUTO_EXPAND_OK_TOKEN'),
      };
    });
    const pass =
      probe.errExpanded === 'true' &&
      probe.okExpanded === 'false' &&
      probe.errBodyVisible === true &&
      probe.okBodyVisible === false;
    record('J5b errored tool block auto-expands; healthy block stays collapsed (#304)',
      'errored block: aria-expanded=true + body visible; healthy block: aria-expanded=false + body hidden',
      JSON.stringify(probe),
      pass,
      !pass ? 'tool failure is hidden behind the chevron — user has to click to find out what went wrong' : '');
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

  // ── Journey 9: per-tool-use cancel IPC (#239) ──────────────────────────
  // Reverse-verify: stash ToolBlock's onCancelStalled handler body and this
  // journey FAILs because the click no longer invokes the IPC stub.
  // Seed a tool block whose `now` makes elapsedMs >= STALL_ESCALATE_AFTER_MS
  // (90s) so the Cancel link renders. Stub window.ccsm.agentCancelToolUse to
  // record calls without touching real main.
  {
    // Use a startedAt 100s in the past relative to a fixed `now` we feed via
    // the store's tick. Easiest path: inject a custom timestamp that the
    // ChatStream already passes as `now` — set the system clock forward in
    // the store after seeding so the elapsedMs counter crosses the
    // escalation threshold.
    await win.evaluate(() => {
      const calls = [];
      window.__ccsm = window.ccsm ?? {};
      window.__cancelCalls = calls;
      // Replace just the one method we want to observe; preserve the rest
      // of the bridge so unrelated renderer code (notify, settings, etc.)
      // still works.
      window.ccsm = new Proxy(window.ccsm ?? {}, {
        get(target, prop) {
          if (prop === 'agentCancelToolUse') {
            return (args) => {
              calls.push(args);
              return Promise.resolve({ ok: true });
            };
          }
          return Reflect.get(target, prop);
        },
      });
    });

    await seed([
      { kind: 'tool', id: 't-cancel', toolUseId: 'tu-cancel-XYZ', name: 'Bash',
        brief: 'sleep 200', expanded: false /* in-flight: no result */ },
    ]);

    // ChatStream drives the elapsed counter via a `now` interval; the easiest
    // way to fast-forward is to wait long enough for the 90s threshold to
    // pass, but that would gate the probe on wall-clock time. Instead, peek
    // at how the block records startedAt internally — it captures Date.now()
    // on first render. We wrap Date.now to add a +95_000ms offset so the
    // very next render frames see "elapsed >= 95s" without any waiting.
    await win.evaluate(() => {
      const realNow = Date.now.bind(Date);
      const offset = 95_000;
      // Snapshot the original first so we can restore after the assertion.
      window.__realDateNow = realNow;
      Date.now = () => realNow() + offset;
      // Force a re-render by appending a no-op assistant block; ChatStream's
      // tick reads the patched Date.now and propagates `now` to ToolBlock.
      window.__ccsmStore.getState().appendBlocks('s-tool', [
        { kind: 'assistant', id: 'a-noop-cancel', text: '' },
      ]);
    });
    // ChatStream's `now` interval ticks every ~100ms; wait a couple cycles.
    await win.waitForTimeout(400);

    const cancelEl = await win.$('[data-testid="tool-stall-cancel"]');
    const cancelVisibleBefore = !!cancelEl;
    let invokedWith = null;
    let cancellingTextAfter = null;
    let ariaDisabledAfter = null;
    if (cancelEl) {
      // Verify aria-label matches the renamed sentence-case string.
      const aria = await cancelEl.getAttribute('aria-label');
      if (aria !== 'Cancel tool') {
        record('J9 cancel link aria-label is "Cancel tool"',
          'aria-label="Cancel tool"',
          `aria-label="${aria}"`,
          false);
      } else {
        record('J9 cancel link aria-label is "Cancel tool"',
          'aria-label="Cancel tool"',
          `aria-label="${aria}"`,
          true);
      }
      await cancelEl.click();
      await win.waitForTimeout(150);
      const observed = await win.evaluate(() => ({
        calls: window.__cancelCalls.slice(),
        text: document.querySelector('[data-testid="tool-stall-cancel"]')?.textContent ?? null,
        aria: document.querySelector('[data-testid="tool-stall-cancel"]')?.getAttribute('aria-disabled') ?? null,
      }));
      invokedWith = observed.calls[0] ?? null;
      cancellingTextAfter = observed.text;
      ariaDisabledAfter = observed.aria;
    }

    // Restore Date.now so subsequent journeys aren't affected if anyone adds
    // more after this one.
    await win.evaluate(() => {
      if (window.__realDateNow) Date.now = window.__realDateNow;
    });

    const passWiring =
      cancelVisibleBefore &&
      invokedWith &&
      invokedWith.sessionId === 's-tool' &&
      invokedWith.toolUseId === 'tu-cancel-XYZ';
    record('J9 cancel button invokes agentCancelToolUse with {sessionId, toolUseId}',
      'after 90s, click on tool-stall-cancel calls agentCancelToolUse({sessionId:"s-tool", toolUseId:"tu-cancel-XYZ"})',
      `cancelVisible=${cancelVisibleBefore}, invokedWith=${JSON.stringify(invokedWith)}`,
      !!passWiring,
      passWiring ? '' : 'click did not propagate to IPC bridge — cancel button is a no-op stub');

    const passCancellingState =
      cancellingTextAfter && /cancelling/i.test(cancellingTextAfter) && ariaDisabledAfter === 'true';
    record('J9b cancel link flips to disabled "Cancelling…" after click',
      'data-testid=tool-stall-cancel text matches /cancelling/i AND aria-disabled="true"',
      `text=${JSON.stringify(cancellingTextAfter)}, aria-disabled=${ariaDisabledAfter}`,
      !!passCancellingState,
      passCancellingState ? '' : 'no transient state — user cannot tell whether the click registered');
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
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
