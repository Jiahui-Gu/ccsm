// E2E: importing a session into a store with empty groups[] AND a stale
// groupId synthesizes a default normal group (carrying nameKey, see worker B
// fix #5) and parents the imported session under it. Pre-fix this combo
// orphaned the imported row at a non-existent groupId; the inline synthesis
// path was duplicated between createSession and importSession (now factored
// into ensureUsableGroup).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const PROBE = 'probe-e2e-import-empty-groups';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[${PROBE}] FAIL: ${msg}`);
  process.exit(1);
}

const ud = isolatedUserData('agentory-import-empty-grp');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development', CCSM_PROD_BUNDLE: '1' }
});

try { // ccsm-probe-cleanup-wrap

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

// Wipe the store: zero sessions, zero groups. Importing into this state
// must synthesize a usable group rather than orphan the imported row.
await win.evaluate(() => {
  window.__ccsmStore.setState({
    groups: [],
    sessions: [],
    activeId: '',
    focusedGroupId: null,
    messagesBySession: {},
    startedSessions: {},
    runningSessions: {},
    interruptedSessions: {},
    messageQueues: {},
    statsBySession: {},
    tutorialSeen: true
  });
});
await win.waitForTimeout(150);

// Drive the importSession action directly — the ImportDialog flow is
// covered by probe-e2e-import-session; here we want to exercise the
// synth path with a known-stale groupId.
const beforeGroupCount = await win.evaluate(
  () => window.__ccsmStore.getState().groups.length
);
if (beforeGroupCount !== 0) {
  await app.close();
  ud.cleanup();
  fail(`expected 0 groups before import, got ${beforeGroupCount}`);
}

const newId = await win.evaluate(() =>
  window.__ccsmStore.getState().importSession({
    name: 'Imported into nothingness',
    cwd: '/tmp/no-group-cwd',
    groupId: 'g-stale-from-old-blob',
    resumeSessionId: 'resume-xyz-123'
  })
);

const after = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  return {
    groups: s.groups,
    sessions: s.sessions,
    activeId: s.activeId
  };
});

if (after.groups.length !== 1) {
  await app.close();
  ud.cleanup();
  fail(`expected 1 synthesized group, got ${after.groups.length}: ${JSON.stringify(after.groups)}`);
}
const synth = after.groups[0];
if (synth.kind !== 'normal') {
  await app.close();
  ud.cleanup();
  fail(`synthesized group should be normal, got kind=${synth.kind}`);
}
if (synth.nameKey !== 'sidebar.defaultGroupName') {
  await app.close();
  ud.cleanup();
  fail(`synthesized group should carry nameKey='sidebar.defaultGroupName', got '${synth.nameKey}' (worker B fix #5)`);
}
if (after.sessions.length !== 1) {
  await app.close();
  ud.cleanup();
  fail(`expected 1 imported session, got ${after.sessions.length}`);
}
const imported = after.sessions[0];
if (imported.id !== newId) {
  await app.close();
  ud.cleanup();
  fail(`importSession returned id=${newId}, but sessions[0].id=${imported.id}`);
}
if (imported.groupId !== synth.id) {
  await app.close();
  ud.cleanup();
  fail(`imported session not parented to synthesized group: groupId=${imported.groupId}, synth.id=${synth.id} — orphan regression`);
}
if (imported.resumeSessionId !== 'resume-xyz-123') {
  await app.close();
  ud.cleanup();
  fail(`resumeSessionId lost: got '${imported.resumeSessionId}'`);
}
if (after.activeId !== newId) {
  await app.close();
  ud.cleanup();
  fail(`activeId should follow the import: expected '${newId}', got '${after.activeId}'`);
}

// Sidebar should render the synthesized group + the imported session row.
const groupHeader = win.locator(`[data-group-header-id="${synth.id}"]`).first();
const headerVisible = await groupHeader.isVisible({ timeout: 3000 }).catch(() => false);
if (!headerVisible) {
  await app.close();
  ud.cleanup();
  fail('synthesized group header not rendered in sidebar');
}
const sidebarRow = win.locator(`li[data-session-id="${imported.id}"]`).first();
const rowVisible = await sidebarRow.isVisible({ timeout: 3000 }).catch(() => false);
if (!rowVisible) {
  await app.close();
  ud.cleanup();
  fail('imported session row not visible in sidebar');
}

console.log(`\n[${PROBE}] OK`);
console.log(`  empty groups[] + stale groupId → synthesized group ${synth.id} (nameKey='${synth.nameKey}')`);
console.log(`  imported session parented correctly + sidebar renders both`);

await app.close();
ud.cleanup();
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
