// E2E: AskUserQuestion full interaction surface (7 user journeys).
//
// Strategy: bypass real claude.exe by directly seeding `kind: 'question'`
// blocks into the renderer's zustand store via `appendBlocks`. This isolates
// the rendering / interaction contract from agent-spawn flakiness and lets
// us assert the journeys deterministically. We ALSO stub `window.agentory`
// IPC functions (`agentSend`, `agentResolvePermission`, `saveMessages`,
// `loadMessages`) so we can capture what the QuestionBlock would have sent
// and so seeded data round-trips through restart.
//
// Each journey is implemented as a small async function. They share a single
// Electron launch where possible to keep total runtime under the 30s probe
// budget; J7 needs its own launch pair because it tests app restart.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const failures = [];
function note(msg) {
  console.log(`[askuserquestion]   ${msg}`);
}
function record(j, ok, detail) {
  const tag = ok ? 'OK  ' : 'FAIL';
  console.log(`[askuserquestion] ${tag}  ${j}  — ${detail}`);
  if (!ok) failures.push(`${j}: ${detail}`);
}

// ── shared helpers ────────────────────────────────────────────────────────
async function newWin(extraEnv = {}, extraArgs = []) {
  const ud = isolatedUserData('agentory-probe-aq');
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`, ...extraArgs],
    cwd: root,
    env: { ...process.env, AGENTORY_PROD_BUNDLE: '1', ...extraEnv },
  });
  const win = await appWindow(app);
  const errors = [];
  win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
  win.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
  });
  await win.waitForLoadState('domcontentloaded');
  // Wait for store to hydrate & a session/composer to be available.
  await win.waitForFunction(
    () => !!window.__agentoryStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  // Force-close the "Claude CLI missing" first-run dialog. Test environments
  // rarely have claude.exe in a discoverable location, so the dialog opens
  // and steals focus, which would invalidate every focus assertion below.
  // We override cliStatus to a synthetic 'found' so the rest of the app
  // behaves as if the binary existed.
  await win.evaluate(() => {
    const store = window.__agentoryStore;
    store.setState({
      cliStatus: { state: 'found', binaryPath: '<probe-stub>', version: '2.1.0' },
    });
  });
  await win.waitForTimeout(150);
  currentApp = app;
  return { app, win, ud, errors };
}

// Helper to locate the QuestionBlock's Submit button. The label is
// translated ("Submit answer" in en, "提交答案" in zh) and other surfaces
// may also use the word "Submit", so we scope to a button INSIDE a question
// container. The question container is identified by the presence of a
// `[data-question-option]` descendant.
function questionSubmitButton(win) {
  return win
    .locator('div.relative', { has: win.locator('[data-question-option]') })
    .last()
    .locator('button')
    .last();
}

// Module-level app handle so journeys can call into main without each one
// having to thread the reference through every helper.
let currentApp = null;

async function installAgentSendCapture(_win) {
  const app = currentApp;
  if (!app) throw new Error('installAgentSendCapture: currentApp not set');
  // Replace the main-side IPC handlers for `agent:send`,
  // `agent:sendContent`, and `agent:resolvePermission` with capturing stubs.
  // Renderer-side patching is impossible because contextBridge freezes
  // `window.agentory`; main-side `ipcMain.handle` re-registration with
  // `removeHandler` first is the supported override path.
  await app.evaluate(({ ipcMain }) => {
    if (!global.__probeCapture) {
      global.__probeCapture = { sent: [], resolved: [] };
    }
    const cap = global.__probeCapture;
    cap.sent.length = 0;
    cap.resolved.length = 0;
    try { ipcMain.removeHandler('agent:send'); } catch {}
    ipcMain.handle('agent:send', (_e, sessionId, text) => {
      cap.sent.push({ sessionId, text });
      return true;
    });
    try { ipcMain.removeHandler('agent:sendContent'); } catch {}
    ipcMain.handle('agent:sendContent', (_e, sessionId, content) => {
      cap.sent.push({ sessionId, content });
      return true;
    });
    try { ipcMain.removeHandler('agent:resolvePermission'); } catch {}
    ipcMain.handle('agent:resolvePermission', (_e, sessionId, requestId, decision) => {
      cap.resolved.push({ sessionId, requestId, decision });
      return true;
    });
  });
}

async function getCapturedSends() {
  const app = currentApp;
  if (!app) return [];
  return await app.evaluate(() => (global.__probeCapture?.sent || []).slice());
}
async function clearCaptured() {
  const app = currentApp;
  if (!app) return;
  await app.evaluate(() => {
    if (global.__probeCapture) {
      global.__probeCapture.sent.length = 0;
      global.__probeCapture.resolved.length = 0;
    }
  });
}

async function ensureSession(win, name = 'probe') {
  return await win.evaluate((sn) => {
    const store = window.__agentoryStore;
    const s = store.getState();
    if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
    s.createSession({ name: sn });
    return store.getState().activeId;
  }, name);
}

async function injectQuestion(win, sessionId, blockId, questions) {
  await win.evaluate(
    ({ sessionId, blockId, questions }) => {
      const store = window.__agentoryStore;
      store.getState().appendBlocks(sessionId, [
        { kind: 'question', id: blockId, questions },
      ]);
    },
    { sessionId, blockId, questions }
  );
}

async function getActiveQuestionBlockHtml(win) {
  return await win.evaluate(() => {
    const root = document.querySelector('[role="group"]') || document.querySelector('label');
    if (!root) return '<no question>';
    const container = root.closest('div.relative');
    return container ? container.outerHTML.slice(0, 3000) : root.outerHTML.slice(0, 3000);
  });
}

// ── J1 ────────────────────────────────────────────────────────────────────
async function journey1_singleSelect_doesNotStealTextarea(win) {
  const sessionId = await ensureSession(win, 'J1');
  await installAgentSendCapture(win);

  // Focus the textarea and type WITHOUT pressing Enter.
  const textarea = win.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 5000 });
  await textarea.click();
  await textarea.fill('half-typed draft');

  // Sanity: textarea is the active element right now.
  const beforeActive = await win.evaluate(() => document.activeElement?.tagName);
  if (beforeActive !== 'TEXTAREA') {
    record('J1', false, `before-inject activeElement=${beforeActive}, expected TEXTAREA`);
    return;
  }

  // Inject a single-question single-select block asynchronously.
  await injectQuestion(win, sessionId, 'q-J1', [
    {
      question: 'Which language?',
      options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Rust' }],
    },
  ]);

  // Wait for the block to render.
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  // Settle past any requestAnimationFrame focus attempts.
  await win.waitForTimeout(150);

  // EXPECTATION 1: textarea STILL has focus.
  const afterActive = await win.evaluate(() => {
    const el = document.activeElement;
    return {
      tag: el?.tagName,
      role: el?.getAttribute?.('role'),
      cls: el?.className?.slice?.(0, 60),
      id: el?.id,
      isQuestionOpt: !!el?.hasAttribute?.('data-question-option'),
      val: el?.value?.slice?.(0, 32),
      textareaFocused: document.activeElement === document.querySelector('textarea'),
      textareaValue: document.querySelector('textarea')?.value?.slice(0, 32),
    };
  });
  if (afterActive.tag !== 'TEXTAREA') {
    record(
      'J1',
      false,
      `auto-focus stole focus: activeElement=${afterActive.tag} role=${afterActive.role} id=${afterActive.id} qOpt=${afterActive.isQuestionOpt} cls=${afterActive.cls} (expected TEXTAREA). textarea draft still=${JSON.stringify(afterActive.textareaValue)}`
    );
    return;
  }

  // Now the user clicks an option to focus the radio group, then keyboard-navs.
  const firstOpt = win.locator('[data-question-option]').first();
  await firstOpt.click();
  await win.waitForTimeout(80);

  // ↓↓↑ to land on index 1 (TypeScript), then Enter.
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(40);
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(40);
  await win.keyboard.press('ArrowUp');
  await win.waitForTimeout(40);

  const focusedValue = await win.evaluate(() => {
    const el = document.activeElement;
    return el ? { role: el.getAttribute('role'), value: el.getAttribute('value') } : null;
  });
  if (focusedValue?.role !== 'radio' || focusedValue?.value !== '1') {
    record('J1', false, `after ↓↓↑ expected radio value=1 focused, got ${JSON.stringify(focusedValue)}`);
    return;
  }

  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);

  const sent = await getCapturedSends();
  if (sent.length !== 1) {
    record('J1', false, `expected 1 captured agentSend, got ${sent.length}: ${JSON.stringify(sent)}`);
    return;
  }
  if (!/TypeScript/.test(sent[0].text || '')) {
    record('J1', false, `expected sent payload to mention TypeScript, got: ${JSON.stringify(sent[0])}`);
    return;
  }
  if (sent[0].sessionId !== sessionId) {
    record('J1', false, `wrong sessionId routed: expected ${sessionId}, got ${sent[0].sessionId}`);
    return;
  }

  // Also: focus should return to the composer after submit.
  await win.waitForTimeout(200);
  const postSubmitFocus = await win.evaluate(() => document.activeElement?.tagName);
  if (postSubmitFocus !== 'TEXTAREA') {
    record('J1', false, `after submit, focus expected TEXTAREA, got ${postSubmitFocus}`);
    return;
  }

  // Clean up the injected block so subsequent journeys start fresh.
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().clearMessages(sid);
  }, sessionId);
  await clearCaptured();
  record('J1', true, 'auto-focus did not steal textarea; ↓↓↑Enter routed TypeScript to correct session; focus returned');
}

// ── J2 ────────────────────────────────────────────────────────────────────
async function journey2_multiSelect_submitGating(win) {
  const sessionId = await ensureSession(win, 'J2');
  await installAgentSendCapture(win);

  // Make sure there is no leftover question block.
  await win.evaluate((sid) => window.__agentoryStore.getState().clearMessages(sid), sessionId);

  await injectQuestion(win, sessionId, 'q-J2', [
    {
      question: 'Pick languages',
      multiSelect: true,
      options: [{ label: 'Python' }, { label: 'TypeScript' }, { label: 'Rust' }],
    },
  ]);
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(120);

  const submitBtn = () => questionSubmitButton(win);

  const initiallyDisabled = await submitBtn().isDisabled();
  if (!initiallyDisabled) {
    record('J2', false, 'multi-select Submit was NOT disabled with 0 picks');
    return;
  }

  // Focus the first checkbox and toggle with Space.
  await win.locator('[data-question-option]').first().focus();
  await win.waitForTimeout(40);
  await win.keyboard.press(' ');
  await win.waitForTimeout(120);

  const afterOnePick = await submitBtn().isDisabled();
  if (afterOnePick) {
    record('J2', false, 'after 1 pick (Space), Submit still disabled');
    return;
  }

  // Press Space again to deselect.
  await win.keyboard.press(' ');
  await win.waitForTimeout(120);

  const afterUntoggle = await submitBtn().isDisabled();
  if (!afterUntoggle) {
    record('J2', false, 'after toggling pick OFF, Submit should be disabled again but was enabled');
    return;
  }

  // Pick two options; Submit must be enabled and submit must include both labels.
  await win.keyboard.press(' '); // re-pick first
  await win.waitForTimeout(60);
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(40);
  await win.keyboard.press(' ');
  await win.waitForTimeout(120);

  const enabledNow = !(await submitBtn().isDisabled());
  if (!enabledNow) {
    record('J2', false, 'with 2 picks Submit should be enabled');
    return;
  }
  await submitBtn().click();
  await win.waitForTimeout(250);
  const sent = await getCapturedSends();
  if (sent.length !== 1) {
    record('J2', false, `expected 1 send, got ${sent.length}`);
    return;
  }
  if (!/Python/.test(sent[0].text) || !/TypeScript/.test(sent[0].text)) {
    record('J2', false, `expected payload to contain Python AND TypeScript, got: ${JSON.stringify(sent[0])}`);
    return;
  }
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().clearMessages(sid);
  }, sessionId);
  await clearCaptured();
  record('J2', true, 'gating tracks current pick count (0→1→0→2); both labels submitted');
}

// ── J3 ────────────────────────────────────────────────────────────────────
async function journey3_threeQuestions_latestPicks(win) {
  const sessionId = await ensureSession(win, 'J3');
  await installAgentSendCapture(win);
  await win.evaluate((sid) => window.__agentoryStore.getState().clearMessages(sid), sessionId);

  await injectQuestion(win, sessionId, 'q-J3', [
    { question: 'Q1 lang', options: [{ label: 'A1' }, { label: 'A2' }, { label: 'A3' }] },
    { question: 'Q2 build', options: [{ label: 'B0' }, { label: 'B1' }, { label: 'B2' }] },
    { question: 'Q3 db', options: [{ label: 'C0' }, { label: 'C1' }] },
  ]);
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  // Click A2 (Q1 idx 1), then B1 (Q2 idx 1), then A3 (Q1 idx 2).
  // Q3 stays on its default (C0).
  const opts = await win.evaluate(() => {
    const all = Array.from(document.querySelectorAll('[data-question-option]'));
    return all.map((n, i) => ({
      i,
      role: n.getAttribute('role'),
      value: n.getAttribute('value'),
      labelText: n.parentElement?.textContent?.trim().slice(0, 30),
    }));
  });
  // Sanity check: 3+3+2 = 8 options total.
  if (opts.length !== 8) {
    record('J3', false, `expected 8 total options, got ${opts.length}`);
    return;
  }

  // We can't trivially identify "Q1 idx 1" by data-question-first alone,
  // but we know the order: first 3 options belong to Q1, next 3 to Q2, next 2 to Q3.
  const allOptions = win.locator('[data-question-option]');
  await allOptions.nth(1).click(); // Q1 → A2
  await win.waitForTimeout(60);
  await allOptions.nth(4).click(); // Q2 → B1
  await win.waitForTimeout(60);
  await allOptions.nth(2).click(); // Q1 → A3 (revise)
  await win.waitForTimeout(120);

  // All answered; submit.
  const submit = questionSubmitButton(win);
  if (await submit.isDisabled()) {
    record('J3', false, 'Submit disabled despite all 3 questions answered (Q3 default-pre-selected)');
    return;
  }
  await submit.click();
  await win.waitForTimeout(250);

  const sent = await getCapturedSends();
  if (sent.length !== 1) {
    record('J3', false, `expected 1 send, got ${sent.length}`);
    return;
  }
  const text = sent[0].text;
  // Stale-pick failure: payload contains A2 (the revised-away pick).
  if (/\bA2\b/.test(text)) {
    record('J3', false, `payload still contains stale pick A2 — picks not refreshed. payload=${JSON.stringify(text)}`);
    return;
  }
  if (!/\bA3\b/.test(text) || !/\bB1\b/.test(text)) {
    record('J3', false, `expected A3 and B1 in payload, got=${JSON.stringify(text)}`);
    return;
  }
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().clearMessages(sid);
  }, sessionId);
  await clearCaptured();
  record('J3', true, `revised picks captured (A3+B1+C0 default), no stale A2`);
}

// ── J4 ────────────────────────────────────────────────────────────────────
async function journey4_twelveOptions_wrapAndSubmit(win) {
  const sessionId = await ensureSession(win, 'J4');
  await installAgentSendCapture(win);
  await win.evaluate((sid) => window.__agentoryStore.getState().clearMessages(sid), sessionId);

  const opts = Array.from({ length: 12 }, (_, i) => ({ label: `Opt-${String(i + 1).padStart(2, '0')}` }));
  await injectQuestion(win, sessionId, 'q-J4', [{ question: 'Pick one of 12', options: opts }]);
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  // Focus first option.
  await win.locator('[data-question-option]').first().focus();
  await win.waitForTimeout(60);

  // ↓ x11 → land on Opt-12 (value="11"). Then ↓ once more → wrap to value="0".
  for (let i = 0; i < 11; i++) {
    await win.keyboard.press('ArrowDown');
    await win.waitForTimeout(20);
  }
  let val = await win.evaluate(() => document.activeElement?.getAttribute('value'));
  if (val !== '11') {
    record('J4', false, `after ↓x11 expected value=11 (Opt-12), got ${val}`);
    return;
  }
  await win.keyboard.press('ArrowDown'); // wrap
  await win.waitForTimeout(40);
  val = await win.evaluate(() => document.activeElement?.getAttribute('value'));
  if (val !== '0') {
    record('J4', false, `expected wrap to value=0 after passing the end; got ${val}`);
    return;
  }

  // Now navigate back to the LAST option and Enter to submit it.
  // From value=0, pressing ArrowUp should wrap UP to last (value=11). Test that too.
  await win.keyboard.press('ArrowUp');
  await win.waitForTimeout(40);
  val = await win.evaluate(() => document.activeElement?.getAttribute('value'));
  if (val !== '11') {
    record('J4', false, `expected ArrowUp from first to wrap to last (value=11), got ${val}`);
    return;
  }

  // Submit via Enter on the focused option (last).
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);

  const sent = await getCapturedSends();
  if (sent.length !== 1 || !/Opt-12/.test(sent[0].text)) {
    record('J4', false, `expected Opt-12 to be submitted, got: ${JSON.stringify(sent)}`);
    return;
  }
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().clearMessages(sid);
  }, sessionId);
  await clearCaptured();
  record('J4', true, 'down wraps to first, up wraps to last, last option submits via Enter');
}

// ── J5 ────────────────────────────────────────────────────────────────────
async function journey5_longLabelDescription_noOverflow(win) {
  const sessionId = await ensureSession(win, 'J5');
  await installAgentSendCapture(win);
  await win.evaluate((sid) => window.__agentoryStore.getState().clearMessages(sid), sessionId);

  const longUrl =
    'https://example.com/' + 'a'.repeat(60); // 80 chars, single token (no break opportunities)
  const longDesc =
    'This-is-a-deliberately-unbreakable-description-' + 'x'.repeat(150); // 200ish chars, no spaces past prefix

  await injectQuestion(win, sessionId, 'q-J5', [
    {
      question: 'Pick endpoint',
      options: [
        { label: longUrl, description: 'short desc' },
        { label: 'Short label', description: longDesc },
      ],
    },
  ]);
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  const overflow = await win.evaluate(() => {
    const stream = document.querySelector('[data-chat-stream]');
    if (!stream) return { ok: false, reason: 'no [data-chat-stream]' };
    const streamW = stream.clientWidth;
    // Find the question container.
    const opt = document.querySelector('[data-question-option]');
    const container = opt?.closest('div.relative');
    if (!container) return { ok: false, reason: 'no question container' };
    const cRect = container.getBoundingClientRect();
    const cScrollW = container.scrollWidth;
    const cClientW = container.clientWidth;
    // Per-option <label> assertions: each option label's own scrollWidth
    // must not exceed its clientWidth (i.e., its content wrapped).
    const labels = Array.from(container.querySelectorAll('label'));
    let labelOverflow = null;
    for (const lbl of labels) {
      if (lbl.scrollWidth > lbl.clientWidth + 1) {
        labelOverflow = {
          cls: lbl.className.slice(0, 60),
          sw: lbl.scrollWidth,
          cw: lbl.clientWidth,
        };
        break;
      }
    }
    // Each label's clientWidth should equal the container's content width
    // (i.e., labels span their parent — they are not horizontally scrolling
    // tracks wider than the container).
    let labelWidthMismatch = null;
    for (const lbl of labels) {
      if (lbl.clientWidth > cClientW + 1) {
        labelWidthMismatch = {
          cls: lbl.className.slice(0, 60),
          labelCw: lbl.clientWidth,
          containerCw: cClientW,
        };
        break;
      }
    }
    // Walk every row inside the container; flag the worst offender.
    const rows = Array.from(container.querySelectorAll('label, div'));
    let worst = null;
    for (const r of rows) {
      const sw = r.scrollWidth;
      const cw = r.clientWidth;
      if (sw > cw + 1) {
        if (!worst || sw - cw > worst.over) {
          worst = { tag: r.tagName, cls: r.className.slice(0, 40), sw, cw, over: sw - cw };
        }
      }
    }
    return {
      ok: true,
      streamW,
      containerW: cRect.width,
      containerScrollW: cScrollW,
      containerClientW: cClientW,
      labelCount: labels.length,
      labelOverflow,
      labelWidthMismatch,
      worstRow: worst,
    };
  });

  if (!overflow.ok) {
    record('J5', false, `overflow probe failed: ${overflow.reason}`);
    return;
  }
  // Container must not horizontally overflow the chat scroll viewport.
  if (overflow.containerW > overflow.streamW + 1) {
    record(
      'J5',
      false,
      `question container width ${overflow.containerW} exceeds chat stream width ${overflow.streamW}`
    );
    return;
  }
  if (overflow.containerScrollW > overflow.containerClientW + 1) {
    record(
      'J5',
      false,
      `question container itself horizontally overflows: scrollW=${overflow.containerScrollW} clientW=${overflow.containerClientW}`
    );
    return;
  }
  if (overflow.labelOverflow) {
    record(
      'J5',
      false,
      `option <label> overflows: ${JSON.stringify(overflow.labelOverflow)} (long URL/desc must wrap)`
    );
    return;
  }
  if (overflow.labelWidthMismatch) {
    record(
      'J5',
      false,
      `option <label> wider than container content: ${JSON.stringify(overflow.labelWidthMismatch)}`
    );
    return;
  }
  if (overflow.worstRow) {
    record(
      'J5',
      false,
      `descendant row overflows: ${JSON.stringify(overflow.worstRow)}`
    );
    return;
  }
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().clearMessages(sid);
  }, sessionId);
  await clearCaptured();
  record('J5', true, `no horizontal overflow (container ${overflow.containerW}px ≤ stream ${overflow.streamW}px; ${overflow.labelCount} labels fit within container ${overflow.containerClientW}px; no offending rows)`);
}

// ── J6 ────────────────────────────────────────────────────────────────────
async function journey6_twoSessions_answerRouting(win) {
  await installAgentSendCapture(win);

  const ids = await win.evaluate(() => {
    const store = window.__agentoryStore;
    // Wipe everything to a known starting point with two fresh sessions.
    store.setState({
      sessions: [],
      activeId: '',
      messagesBySession: {},
      messageQueues: {},
      runningSessions: {},
      startedSessions: {},
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    });
    const s = store.getState();
    s.createSession({ name: 'A' });
    const aId = store.getState().activeId;
    s.createSession({ name: 'B' });
    const bId = store.getState().activeId;
    return { aId, bId };
  });

  await injectQuestion(win, ids.aId, 'q-A', [
    { question: 'A?', options: [{ label: 'A-Yes' }, { label: 'A-No' }] },
  ]);
  await injectQuestion(win, ids.bId, 'q-B', [
    { question: 'B?', options: [{ label: 'B-Yes' }, { label: 'B-No' }] },
  ]);

  // Currently active is B (the most recently created). Verify and submit B's question.
  const activeNow = await win.evaluate(() => window.__agentoryStore.getState().activeId);
  if (activeNow !== ids.bId) {
    record('J6', false, `expected active=${ids.bId} (B), got ${activeNow}`);
    return;
  }
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  // Submit B (default-picked first option).
  await questionSubmitButton(win).click();
  await win.waitForTimeout(300);

  let sent = await getCapturedSends();
  if (sent.length !== 1) {
    record('J6', false, `after answering B, expected 1 send got ${sent.length}: ${JSON.stringify(sent)}`);
    return;
  }
  if (sent[0].sessionId !== ids.bId) {
    record('J6', false, `B answer routed to wrong session: ${sent[0].sessionId} (expected ${ids.bId})`);
    return;
  }
  if (!/B-Yes/.test(sent[0].text)) {
    record('J6', false, `B answer payload does not contain B-Yes: ${JSON.stringify(sent[0])}`);
    return;
  }

  // Switch to A and verify the visible question still belongs to A
  // (no leakage of B's now-answered Q into A).
  await win.evaluate((aId) => window.__agentoryStore.getState().selectSession(aId), ids.aId);
  await win.waitForTimeout(250);
  // The question block for A should have its options "A-Yes / A-No".
  const labelsInA = await win.evaluate(() =>
    Array.from(document.querySelectorAll('[data-question-option]')).map(
      (n) => n.parentElement?.textContent?.trim().slice(0, 20)
    )
  );
  if (!labelsInA.some((l) => /A-Yes/.test(l ?? '')) || labelsInA.some((l) => /B-Yes/.test(l ?? ''))) {
    record(
      'J6',
      false,
      `after switching to A, options should be A-* only; got: ${JSON.stringify(labelsInA)}`
    );
    return;
  }

  // Submit A.
  await questionSubmitButton(win).click();
  await win.waitForTimeout(300);
  sent = await getCapturedSends();
  if (sent.length !== 2) {
    record('J6', false, `after answering A, expected 2 total sends got ${sent.length}`);
    return;
  }
  if (sent[1].sessionId !== ids.aId || !/A-Yes/.test(sent[1].text)) {
    record(
      'J6',
      false,
      `A answer routed wrong: sessionId=${sent[1].sessionId} (expected ${ids.aId}), text=${JSON.stringify(sent[1].text)}`
    );
    return;
  }
  await win.evaluate(() => {
    /* nothing to clean up in renderer */
  });
  await clearCaptured();
  record('J6', true, 'answers routed to correct sessions; no question leakage on switch');
}

// ── J7 (separate launch pair) ────────────────────────────────────────────
async function journey7_restartInteractive() {
  const ud = isolatedUserData('agentory-probe-aq-restart');
  const args = ['.', `--user-data-dir=${ud.dir}`];
  const env = { ...process.env, AGENTORY_PROD_BUNDLE: '1' };

  const SESSION_ID = 's-aq-restart';
  const QUESTION_BLOCK_ID = 'q-restart';

  // Launch #1: seed a session + persisted question block + activeId.
  {
    const app = await electron.launch({ args, cwd: root, env });
    const win = await appWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.agentory, null, { timeout: 15_000 });

    const seeded = await win.evaluate(
      async ({ sid, qid }) => {
        const api = window.agentory;
        if (!api) return { ok: false, err: 'no agentory' };
        const state = {
          version: 1,
          sessions: [
            {
              id: sid,
              name: 'Restart probe',
              state: 'idle',
              cwd: '~',
              model: 'claude-opus-4',
              groupId: 'g-default',
              agentType: 'claude-code',
            },
          ],
          groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
          activeId: sid,
          model: 'claude-opus-4',
          permission: 'default',
          sidebarCollapsed: false,
          theme: 'system',
          fontSize: 'md',
          recentProjects: [],
          tutorialSeen: true,
        };
        await api.saveState('main', JSON.stringify(state));
        const block = {
          kind: 'question',
          id: qid,
          questions: [
            { question: 'After restart still alive?', options: [{ label: 'Alive' }, { label: 'Frozen' }] },
          ],
        };
        await api.saveMessages(sid, [block]);
        const back = await api.loadMessages(sid);
        return { ok: true, backLen: back.length, backKind: back[0]?.kind };
      },
      { sid: SESSION_ID, qid: QUESTION_BLOCK_ID }
    );
    if (!seeded.ok) {
      await app.close();
      record('J7', false, `seed failed: ${seeded.err}`);
      ud.cleanup();
      return;
    }
    if (seeded.backLen !== 1 || seeded.backKind !== 'question') {
      await app.close();
      record('J7', false, `db roundtrip wrong: len=${seeded.backLen} kind=${seeded.backKind}`);
      ud.cleanup();
      return;
    }
    await app.close();
  }

  // Launch #2: assert the question block re-renders AND is still interactive.
  {
    const app = await electron.launch({ args, cwd: root, env });
    currentApp = app;
    const win = await appWindow(app);
    const errors = [];
    win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    win.on('console', (m) => {
      if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
    });
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.agentory && !!window.__agentoryStore, null, { timeout: 20_000 });
    await win.waitForTimeout(1000);
    // Suppress the CLI-missing first-run dialog so it doesn't trap focus.
    await win.evaluate(() => {
      window.__agentoryStore.setState({
        cliStatus: { state: 'found', binaryPath: '<probe-stub>', version: '2.1.0' },
      });
    });
    await win.waitForTimeout(150);

    // Hydrate has already run + loaded messages for activeId. Wait briefly
    // for the question block to mount.
    let rendered = false;
    for (let i = 0; i < 30; i++) {
      const present = await win.evaluate(() => !!document.querySelector('[data-question-option]'));
      if (present) {
        rendered = true;
        break;
      }
      await win.waitForTimeout(200);
    }
    if (!rendered) {
      const dump = await win.evaluate(() => {
        const main = document.querySelector('main');
        return main ? main.innerText.slice(0, 1500) : '<no main>';
      });
      console.error('--- main after restart ---\n' + dump);
      console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
      await app.close();
      record('J7', false, 'question block did not re-render after restart');
      ud.cleanup();
      return;
    }

    // Stub agentSend so we can detect interactive submission without a real agent.
    await installAgentSendCapture(win);

    // Try to interact: focus an option, press Enter (single-select default-picked).
    const opt = win.locator('[data-question-option]').first();
    await opt.focus();
    await win.waitForTimeout(80);

    const submitBtn = questionSubmitButton(win);
    const submitDisabled = await submitBtn.isDisabled().catch(() => true);
    if (submitDisabled) {
      // If implementation chose to render restored questions as read-only
      // history, this is the discrepancy we must report — not a probe bug.
      const meta = await win.evaluate(() => {
        const opt = document.querySelector('[data-question-option]');
        return opt
          ? {
              tag: opt.tagName,
              disabled: opt.hasAttribute('disabled'),
              dataDisabled: opt.getAttribute('data-disabled'),
              dataState: opt.getAttribute('data-state'),
            }
          : null;
      });
      await app.close();
      record(
        'J7',
        false,
        `EXPECTED interactive after restart, but Submit is disabled. Implementation appears to render restored question as read-only / pre-submitted. opt meta=${JSON.stringify(meta)}`
      );
      ud.cleanup();
      return;
    }

    await submitBtn.click();
    await win.waitForTimeout(400);
    const sent = await getCapturedSends();
    if (sent.length !== 1) {
      await app.close();
      record('J7', false, `expected 1 send after restart-Submit, got ${sent.length}`);
      ud.cleanup();
      return;
    }
    if (sent[0].sessionId !== SESSION_ID || !/Alive/.test(sent[0].text)) {
      await app.close();
      record(
        'J7',
        false,
        `restart-submit routed wrong: ${JSON.stringify(sent[0])} (expected sessionId=${SESSION_ID} containing Alive)`
      );
      ud.cleanup();
      return;
    }
    await app.close();
    record('J7', true, 'persisted question block re-rendered and remained interactive across restart');
    ud.cleanup();
  }
}

// ── runner ────────────────────────────────────────────────────────────────
const { app, win, ud } = await newWin();
async function safeRun(name, fn) {
  try {
    await fn(win);
  } catch (e) {
    record(name, false, `unhandled exception: ${e.message?.slice(0, 200)}`);
    // Best-effort cleanup so the next journey starts from a known state.
    try {
      await win.evaluate(() => {
        const s = window.__agentoryStore?.getState?.();
        if (!s) return;
        for (const sid of Object.keys(s.messagesBySession || {})) s.clearMessages(sid);
      });
      await clearCaptured();
    } catch {}
  }
}
try {
  await safeRun('J1', journey1_singleSelect_doesNotStealTextarea);
  await safeRun('J2', journey2_multiSelect_submitGating);
  await safeRun('J3', journey3_threeQuestions_latestPicks);
  await safeRun('J4', journey4_twelveOptions_wrapAndSubmit);
  await safeRun('J5', journey5_longLabelDescription_noOverflow);
  await safeRun('J6', journey6_twoSessions_answerRouting);
} finally {
  await app.close().catch(() => {});
  ud.cleanup();
}

try {
  await journey7_restartInteractive();
} catch (e) {
  record('J7', false, `unhandled exception: ${e.message?.slice(0, 200)}`);
}

console.log('\n=== AskUserQuestion journey summary ===');
if (failures.length === 0) {
  console.log('[askuserquestion] all 7 journeys matched expected behavior');
  process.exit(0);
} else {
  console.log(`[askuserquestion] ${failures.length} discrepancy / failure(s):`);
  for (const f of failures) console.log(`  - ${f}`);
  // NOTE: per the methodology, a failure here may be a CORRECT discrepancy
  // surfacing that needs the manager / reviewer to decide if expectations or
  // implementation should change. We still exit non-zero so CI flags it.
  process.exit(1);
}
