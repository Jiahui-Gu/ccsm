// Regression probe for Bug 1 (PR #149): clicking the sidebar's "New Session"
// button when there's no usable (kind='normal') group must atomically synthesize
// a default normal group AND insert a session into it, then activate the
// session — so the user immediately sees a row in the sidebar and a composer
// in the main pane.
//
// Two scenarios cover both empty-store paths:
//   A. groups: []                     → synthesize new normal group
//   B. groups: [{kind:'archive'}]     → leave archive intact, synthesize new
//                                       normal group beside it
//
// Pre-fix verification: hardcoding `firstUsableGroupId` to return null and
// removing the inline-synthesis branch from `createSession` causes both
// scenarios to fail (no group is created, the new session ends up orphaned
// with `groupId === undefined` and no row appears in the sidebar). See PR
// description for the diff used to confirm this.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, seedStore } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-empty-group-new-session] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 10000 });

async function clickSidebarNewSession() {
  // Scope to <aside> so we don't accidentally hit the empty-state CTA in
  // <main> which has the same accessible name.
  const btn = win.locator('aside').getByRole('button', { name: /^New Session$/ });
  await btn.first().waitFor({ state: 'visible', timeout: 10000 });
  await btn.first().click();
}

async function readState() {
  return await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return {
      groups: s.groups.map((g) => ({ id: g.id, name: g.name, kind: g.kind })),
      sessions: s.sessions.map((x) => ({ id: x.id, groupId: x.groupId, name: x.name })),
      activeId: s.activeId
    };
  });
}

async function expectComposerVisible() {
  // After activeId flips, the InputBar mounts. Its textarea uses the
  // localized placeholder "Ask anything…" when the session has no messages.
  const composer = win.getByPlaceholder(/Ask anything…|Reply…/);
  try {
    await composer.first().waitFor({ state: 'visible', timeout: 10000 });
  } catch {
    return false;
  }
  return true;
}

// ── Scenario A: zero groups ─────────────────────────────────────────────────
await seedStore(win, {
  groups: [],
  sessions: [],
  activeId: undefined,
  tutorialSeen: true
});

await clickSidebarNewSession();
await win.waitForFunction(
  () => {
    const s = window.__ccsmStore.getState();
    return s.groups.length === 1 && s.sessions.length === 1 && !!s.activeId;
  },
  null,
  { timeout: 10000 }
);

{
  const st = await readState();
  if (st.groups.length !== 1) { await app.close(); fail(`A: expected 1 group, got ${st.groups.length}`); }
  const g = st.groups[0];
  if (g.kind !== 'normal') { await app.close(); fail(`A: synthesized group should be kind=normal, got ${g.kind}`); }
  if (g.name !== 'Sessions') { await app.close(); fail(`A: synthesized group name should be "Sessions" (en default), got "${g.name}"`); }
  if (st.sessions.length !== 1) { await app.close(); fail(`A: expected 1 session, got ${st.sessions.length}`); }
  const s = st.sessions[0];
  if (s.groupId !== g.id) { await app.close(); fail(`A: session.groupId=${s.groupId} should equal new group id ${g.id}`); }
  if (st.activeId !== s.id) { await app.close(); fail(`A: activeId=${st.activeId} should equal new session id ${s.id}`); }
  if (!(await expectComposerVisible())) { await app.close(); fail('A: composer not visible after createSession'); }
}

// ── Scenario B: only archived groups ────────────────────────────────────────
await seedStore(win, {
  groups: [{ id: 'g-old', name: 'Old', collapsed: false, kind: 'archive' }],
  sessions: [],
  activeId: undefined,
  tutorialSeen: true
});

await clickSidebarNewSession();
await win.waitForFunction(
  () => {
    const s = window.__ccsmStore.getState();
    return s.groups.length === 2 && s.sessions.length === 1 && !!s.activeId;
  },
  null,
  { timeout: 10000 }
);

{
  const st = await readState();
  if (st.groups.length !== 2) { await app.close(); fail(`B: expected 2 groups, got ${st.groups.length}`); }
  const old = st.groups.find((g) => g.id === 'g-old');
  if (!old) { await app.close(); fail('B: original archived group "g-old" was lost'); }
  if (old.kind !== 'archive') { await app.close(); fail(`B: original group kind mutated to ${old.kind}`); }
  const fresh = st.groups.find((g) => g.id !== 'g-old');
  if (!fresh || fresh.kind !== 'normal') { await app.close(); fail(`B: expected a new normal group beside archive, got ${JSON.stringify(fresh)}`); }
  if (fresh.name !== 'Sessions') { await app.close(); fail(`B: synthesized group name should be "Sessions", got "${fresh.name}"`); }
  if (st.sessions.length !== 1) { await app.close(); fail(`B: expected 1 session, got ${st.sessions.length}`); }
  const s = st.sessions[0];
  if (s.groupId !== fresh.id) { await app.close(); fail(`B: session should belong to the new normal group ${fresh.id}, got ${s.groupId}`); }
  if (st.activeId !== s.id) { await app.close(); fail(`B: activeId=${st.activeId} should equal new session id ${s.id}`); }
  if (!(await expectComposerVisible())) { await app.close(); fail('B: composer not visible after createSession'); }
}

console.log('\n[probe-e2e-empty-group-new-session] OK');
console.log('  A: zero groups  → 1 normal group + 1 session, activated, composer visible');
console.log('  B: only archive → archive preserved, new normal group + session, composer visible');
await app.close();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
