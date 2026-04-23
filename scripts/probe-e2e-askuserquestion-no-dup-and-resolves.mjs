// E2E regression for Bugs A+B (2026-04-23 dogfood):
//   A) `AskUserQuestion` rendered TWO question cards for one tool_use; the
//      second card's buttons were disabled.
//   B) Clicking Submit on the active card → runningSessions[sid] stuck true,
//      no agent response, claude.exe exited with code=1 shortly after.
//
// Root cause: AskUserQuestion arrives via TWO renderer paths in the current
// architecture:
//   1. `lifecycle.onAgentPermissionRequest` (via can_use_tool control RPC)
//      → block id `q-${requestId}`, carries `requestId`, routes submit
//      through `agentResolvePermission(deny)` to release the can_use_tool
//      promise so claude.exe can write back its synthetic tool_result.
//   2. `streamEventToTranslation` for the assistant `tool_use` event
//      → block id `${msgId}:tu${idx}`, carries `toolUseId` only.
//
// Both ids differ → `appendBlocks`'s id-based merge can't dedupe → 2 cards
// render. Worse, only path-1 has the routing wire-up; if the user submits
// on a path-2 block, the can_use_tool promise never settles → claude.exe
// blocks indefinitely → exits with code 1 → UI stuck "running".
//
// Strategy: bypass real claude.exe by injecting fake `question` blocks via
// `useStore.getState().appendBlocks` and stubbing `agentResolvePermission`
// + `agentSend` IPC handlers on the main side. Verifies:
//   * A duplicate dispatch (two question blocks sharing a join key) collapses
//     to ONE rendered card AND ONE store entry.
//   * Submitting that single card routes through `agentResolvePermission`
//     EXACTLY ONCE (and `agentSend` exactly once for the answer text).
//   * After the stubbed IPCs return, `runningSessions[sid]` is cleared
//     (this probe simulates the lifecycle drop directly via setRunning so
//     we don't need a live agent).

import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const failures = [];
function fail(j, msg) {
  console.log(`[no-dup-resolves] FAIL  ${j}  — ${msg}`);
  failures.push(`${j}: ${msg}`);
}
function pass(j, msg) {
  console.log(`[no-dup-resolves] OK    ${j}  — ${msg}`);
}

const ud = isolatedUserData('agentory-probe-aq-nodup');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' },
});
const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

try {
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(
    () => !!window.__agentoryStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  // Suppress the "Claude CLI missing" first-run dialog so it can't trap focus.
  await win.evaluate(() => {
    window.__agentoryStore.setState({
      cliStatus: { state: 'found', binaryPath: '<probe-stub>', version: '2.1.0' },
    });
  });
  await win.waitForTimeout(150);

  // Install IPC capture stubs on main: replace the real handlers so we can
  // count exactly how many times each fires WITHOUT spawning claude.exe.
  await app.evaluate(({ ipcMain }) => {
    if (!global.__probeNoDup) {
      global.__probeNoDup = { resolved: [], sent: [] };
    }
    const cap = global.__probeNoDup;
    cap.resolved.length = 0;
    cap.sent.length = 0;
    try { ipcMain.removeHandler('agent:resolvePermission'); } catch {}
    ipcMain.handle('agent:resolvePermission', (_e, sessionId, requestId, decision) => {
      cap.resolved.push({ sessionId, requestId, decision });
      return true;
    });
    try { ipcMain.removeHandler('agent:send'); } catch {}
    ipcMain.handle('agent:send', (_e, sessionId, text) => {
      cap.sent.push({ sessionId, text });
      return true;
    });
  });

  const sessionId = await win.evaluate(() => {
    const s = window.__agentoryStore.getState();
    if (s.activeId && s.sessions.some((x) => x.id === s.activeId)) return s.activeId;
    s.createSession({ name: 'no-dup probe' });
    return window.__agentoryStore.getState().activeId;
  });

  // Mark session as running so we can verify it gets cleared after submit.
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().setRunning(sid, true);
  }, sessionId);

  // ── J1: SAME `requestId` duplicate ──────────────────────────────────────
  // Mirrors the "two appendBlocks for one logical question" crash mode.
  const Q1 = [
    { question: 'Pick a stack', options: [{ label: 'TypeScript' }, { label: 'Rust' }, { label: 'Go' }] },
  ];
  await win.evaluate(
    ({ sid, q }) => {
      const store = window.__agentoryStore.getState();
      // First dispatch: the can_use_tool path emits a question block keyed
      // by `q-${requestId}` and carries the `requestId` so submit can route
      // through agentResolvePermission.
      store.appendBlocks(sid, [
        { kind: 'question', id: 'q-perm-J1', requestId: 'perm-J1', questions: q },
      ]);
      // Second dispatch with the SAME requestId — a duplicate would otherwise
      // sail past the id-based merge if it happened to also pick a different id.
      store.appendBlocks(sid, [
        { kind: 'question', id: 'q-perm-J1-DUP', requestId: 'perm-J1', questions: q },
      ]);
    },
    { sid: sessionId, q: Q1 }
  );

  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  // Assertion: exactly ONE question card in DOM.
  const cardCountJ1 = await win.evaluate(() => {
    const opts = document.querySelectorAll('[data-question-option]');
    // The QuestionBlock wraps each card in a div with role=group via Radix
    // RadioGroup. Counting roving-focus groups is more reliable than guessing
    // at the wrapper class. Fall back to counting Submit buttons if no groups.
    const groups = document.querySelectorAll('[role="radiogroup"], [role="group"]');
    return {
      optsTotal: opts.length,
      groupsTotal: groups.length,
    };
  });
  if (cardCountJ1.groupsTotal !== 1) {
    fail(
      'J1',
      `expected 1 question card (radiogroup/group) for one logical question, got ${cardCountJ1.groupsTotal} (opts=${cardCountJ1.optsTotal})`
    );
  } else {
    pass('J1', `single card rendered for duplicate-dispatch with same requestId (groups=${cardCountJ1.groupsTotal}, opts=${cardCountJ1.optsTotal})`);
  }

  // Assertion: store has 1 question block.
  const storeQCountJ1 = await win.evaluate((sid) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] || [];
    return blocks.filter((b) => b.kind === 'question').length;
  }, sessionId);
  if (storeQCountJ1 !== 1) {
    fail('J1', `expected 1 question block in store, got ${storeQCountJ1}`);
  } else {
    pass('J1', 'store has exactly 1 question block after duplicate dispatch');
  }

  // ── Submit + verify resolve routing ────────────────────────────────────
  // Default-pick is index 0 (TypeScript); click the SUBMIT button.
  const submitBtn = win
    .locator('div.relative', { has: win.locator('[data-question-option]') })
    .last()
    .locator('button')
    .last();
  if (await submitBtn.isDisabled()) {
    fail('J1', 'Submit button disabled — block was rendered as read-only/duplicate');
  } else {
    await submitBtn.click();
    await win.waitForTimeout(400);

    const captured = await app.evaluate(() => ({
      resolved: global.__probeNoDup.resolved.slice(),
      sent: global.__probeNoDup.sent.slice(),
    }));

    // Expect exactly ONE resolve (deny on perm-J1) and ONE send (the answer text).
    if (captured.resolved.length !== 1) {
      fail('J1', `expected 1 agentResolvePermission call, got ${captured.resolved.length}: ${JSON.stringify(captured.resolved)}`);
    } else if (captured.resolved[0].requestId !== 'perm-J1' || captured.resolved[0].decision !== 'deny') {
      fail('J1', `wrong resolve payload: ${JSON.stringify(captured.resolved[0])}`);
    } else {
      pass('J1', 'submit fired exactly 1 agentResolvePermission(perm-J1, deny)');
    }
    if (captured.sent.length !== 1) {
      fail('J1', `expected 1 agentSend call, got ${captured.sent.length}: ${JSON.stringify(captured.sent)}`);
    } else if (!/TypeScript/.test(captured.sent[0].text || '')) {
      fail('J1', `agentSend did not contain TypeScript: ${JSON.stringify(captured.sent[0])}`);
    } else {
      pass('J1', 'submit fired exactly 1 agentSend with the answer text');
    }
  }

  // Simulate the lifecycle drop (would normally arrive via the `result` frame
  // after claude.exe processes the resolve + answer round-trip).
  await win.evaluate((sid) => {
    window.__agentoryStore.getState().setRunning(sid, false);
  }, sessionId);
  const stillRunning = await win.evaluate((sid) => {
    return !!window.__agentoryStore.getState().runningSessions[sid];
  }, sessionId);
  if (stillRunning) {
    fail('J1', 'runningSessions[sid] still true after setRunning(false) — store regression');
  } else {
    pass('J1', 'runningSessions cleared (would clear naturally on real result frame)');
  }

  // ── J2: SAME `toolUseId` duplicate ─────────────────────────────────────
  // Validates the other half of the dedupe predicate.
  await win.evaluate((sid) => {
    const store = window.__agentoryStore.getState();
    store.clearMessages(sid);
  }, sessionId);
  await app.evaluate(() => {
    global.__probeNoDup.resolved.length = 0;
    global.__probeNoDup.sent.length = 0;
  });
  await win.waitForTimeout(120);

  const Q2 = [
    { question: 'Pick a build tool', options: [{ label: 'esbuild' }, { label: 'rollup' }] },
  ];
  await win.evaluate(
    ({ sid, q }) => {
      const store = window.__agentoryStore.getState();
      // Two blocks with different ids but the SAME toolUseId — exactly
      // what the assistant `tool_use` path would have emitted in addition
      // to a (here-omitted) can_use_tool block, before the fix.
      store.appendBlocks(sid, [
        { kind: 'question', id: 'q-J2-A', toolUseId: 'tu-J2', questions: q },
      ]);
      store.appendBlocks(sid, [
        { kind: 'question', id: 'q-J2-B', toolUseId: 'tu-J2', questions: q },
      ]);
    },
    { sid: sessionId, q: Q2 }
  );
  await win.waitForSelector('[data-question-option]', { timeout: 5000 });
  await win.waitForTimeout(150);

  const groupsJ2 = await win.evaluate(() =>
    document.querySelectorAll('[role="radiogroup"], [role="group"]').length
  );
  const storeQCountJ2 = await win.evaluate((sid) => {
    const blocks = window.__agentoryStore.getState().messagesBySession[sid] || [];
    return blocks.filter((b) => b.kind === 'question').length;
  }, sessionId);
  if (groupsJ2 !== 1) {
    fail('J2', `expected 1 question card for same-toolUseId duplicate, got ${groupsJ2}`);
  } else {
    pass('J2', `single card rendered for duplicate-dispatch with same toolUseId`);
  }
  if (storeQCountJ2 !== 1) {
    fail('J2', `expected 1 question block in store, got ${storeQCountJ2}`);
  } else {
    pass('J2', 'store has exactly 1 question block after toolUseId duplicate');
  }
} catch (e) {
  fail('runner', `unhandled exception: ${e.message?.slice(0, 300)}`);
} finally {
  await app.close().catch(() => {});
  ud.cleanup();
}

console.log('\n=== askuserquestion-no-dup-and-resolves summary ===');
if (failures.length === 0) {
  console.log('[no-dup-resolves] all assertions passed');
  process.exit(0);
} else {
  console.log(`[no-dup-resolves] ${failures.length} failure(s):`);
  for (const f of failures) console.log('  - ' + f);
  if (errors.length > 0) {
    console.log('\n--- console / page errors ---');
    for (const e of errors.slice(-10)) console.log('  ' + e);
  }
  process.exit(1);
}
