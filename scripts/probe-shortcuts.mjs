import { chromium } from 'playwright';

const browser = await chromium.launch();
const ctx = await browser.newContext();
const page = await ctx.newPage();

const logs = [];
page.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}\n${e.stack ?? ''}`));
page.on('requestfailed', (r) => logs.push(`[reqfail] ${r.url()} ${r.failure()?.errorText}`));

await page.goto('http://localhost:4100/', { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);

const result = await page.evaluate(async () => {
  const out = { steps: [], errors: [], checks: {} };
  try {
    const useStore = window.__agentoryStore;
    if (!useStore) throw new Error('window.__agentoryStore missing');

    const before = useStore.getState();
    const sessionsBefore = before.sessions.length;
    const groupsBefore = before.groups.length;
    out.steps.push(`baseline: ${sessionsBefore} sessions, ${groupsBefore} groups`);

    // Cmd+N -> new session (single window dispatch; document+window double-fires)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', code: 'KeyN', ctrlKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));

    const afterN = useStore.getState();
    out.checks.newSessionCreated = afterN.sessions.length === sessionsBefore + 1;
    out.steps.push(`after Cmd+N: ${afterN.sessions.length} sessions`);

    // Cmd+Shift+N -> new group
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'N', code: 'KeyN', ctrlKey: true, shiftKey: true, bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));

    const afterShiftN = useStore.getState();
    out.checks.newGroupCreated = afterShiftN.groups.length === groupsBefore + 1;
    out.steps.push(`after Cmd+Shift+N: ${afterShiftN.groups.length} groups`);

    // Background waiting bridge: install a fake permission request via the
    // store directly. Since there's no live SDK in dev:web, we simulate by
    // appending a waiting block on a NON-active session and confirm the
    // toast bridge would fire IF the lifecycle saw a real one.
    // The bridge sets a global handler; we can call it directly.
    // The bridge is registered via setBackgroundWaitingHandler — to invoke
    // we'd need to import lifecycle. Easier: trigger via the lifecycle
    // exported handler by replicating what onAgentPermissionRequest does.

    // Create a second session so we have a "background" target.
    useStore.getState().createSession('~/bg-cwd');
    const bgSid = useStore.getState().activeId;
    // Make active session something else
    const otherSid = useStore.getState().sessions.find((s) => s.id !== bgSid)?.id;
    if (otherSid) useStore.getState().selectSession(otherSid);
    out.steps.push(`bg session ${bgSid}, active ${useStore.getState().activeId}`);

    // The toast push is encapsulated; easiest E2E check is to look at the
    // toast region's children count after manually firing a permission
    // request would arrive. We can't fire onAgentPermissionRequest from the
    // page (window.agentory is undefined in dev:web). So toast
    // verification is best-effort: confirm the toast root exists and is
    // empty, then assert no errors occurred during shortcut handling.
    const toastRoot = document.querySelector('.pointer-events-none.fixed.bottom-3.right-3');
    out.checks.toastRootExists = !!toastRoot;
    out.checks.toastRootEmpty = toastRoot ? toastRoot.children.length === 0 : null;
  } catch (e) {
    out.errors.push(String(e?.stack ?? e));
  }
  return out;
});

console.log('=== STEPS ===');
for (const s of result.steps) console.log('  -', s);

if (result.errors.length) {
  console.log('=== ERRORS ===');
  for (const e of result.errors) console.log(e);
}

console.log('\n=== CHECKS ===');
console.log(JSON.stringify(result.checks, null, 2));

console.log('\n=== CONSOLE / PAGE ERRORS ===');
for (const l of logs) console.log(l);

await browser.close();
