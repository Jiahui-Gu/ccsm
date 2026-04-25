// E2E: import session via the sidebar Import button + ImportDialog.
//
// Three cases under test (one PR fixes all three — Task #219):
//
//   Case 1 (Bug A): import a planted CLI .jsonl and verify the imported chat
//     is hydrated immediately with the prior history blocks (NOT empty until
//     the user sends a follow-up — that was the whole regression).
//
//   Case 2 (Bug B): plant a sub-agent transcript (parentUuid set on first
//     frame) AND a sidechain transcript (isSidechain:true) alongside a clean
//     one. Only the clean one should appear in the dialog.
//
//   Case 3 (Bug C / Dogfood-H): plant a transcript whose cwd lives under the
//     platform temp dir AND has an `agentory-` segment (e.g. our own bash
//     spawn cwds). Should be filtered from the picker.
//
// All cases sandbox HOME / USERPROFILE per project_probe_skill_injection.md
// so the test never touches the developer's real ~/.claude/projects/ and
// never picks up locally-installed skills.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import os from 'node:os';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-import-session] FAIL: ${msg}`);
  process.exit(1);
}

// ─── Plant a sandboxed HOME with a mix of fixtures ─────────────────────────
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agentory-probe-import-home-'));
const projectsRoot = path.join(fakeHome, '.claude', 'projects');
fs.mkdirSync(projectsRoot, { recursive: true });

function plantSession(projDirName, sessionId, frames) {
  const dir = path.join(projectsRoot, projDirName);
  fs.mkdirSync(dir, { recursive: true });
  const lines = frames.map((f) => JSON.stringify(f)).join('\n') + '\n';
  fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), lines);
}

const now = Date.now();
const TS = new Date(now).toISOString();

// (1) Clean top-level session — what the user actually wants to import.
//     Carries a real user→assistant turn so we can verify history hydration.
const CLEAN_SID = 'aaaaaaa1-1111-1111-1111-111111111111';
const CLEAN_CWD = '/tmp/probe-fixture-clean';
plantSession('-tmp-probe-fixture-clean', CLEAN_SID, [
  { type: 'permission-mode', permissionMode: 'default', sessionId: CLEAN_SID },
  {
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    uuid: 'u-clean-1',
    cwd: CLEAN_CWD,
    sessionId: CLEAN_SID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: 'PROBE_USER_TEXT_HELLO' }] }
  },
  {
    type: 'assistant',
    session_id: CLEAN_SID,
    parentUuid: 'u-clean-1',
    isSidechain: false,
    uuid: 'a-clean-1',
    cwd: CLEAN_CWD,
    timestamp: TS,
    message: {
      id: 'msg-clean-1',
      role: 'assistant',
      model: 'claude-opus-4-7',
      content: [{ type: 'text', text: 'PROBE_ASSISTANT_TEXT_REPLY' }]
    }
  }
]);

// (2) Sub-agent transcript: first frame carries parentUuid (Task tool spawn).
const SUBAGENT_SID = 'bbbbbbb2-2222-2222-2222-222222222222';
plantSession('-tmp-probe-fixture-clean', SUBAGENT_SID, [
  {
    type: 'user',
    parentUuid: 'parent-real-uuid-123',
    isSidechain: false,
    uuid: 'u-sub-1',
    cwd: CLEAN_CWD,
    sessionId: SUBAGENT_SID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: 'PROBE_SUBAGENT_LEAK' }] }
  }
]);

// (3) Sidechain transcript: isSidechain:true on the first frame.
const SIDECHAIN_SID = 'ccccccc3-3333-3333-3333-333333333333';
plantSession('-tmp-probe-fixture-clean', SIDECHAIN_SID, [
  {
    type: 'user',
    parentUuid: null,
    isSidechain: true,
    uuid: 'u-side-1',
    cwd: CLEAN_CWD,
    sessionId: SIDECHAIN_SID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: 'PROBE_SIDECHAIN_LEAK' }] }
  }
]);

// (4) CCSM-temp cwd transcript: top-level (parentUuid null) but the cwd
//     lives under the platform tmp dir with an `agentory-` segment. This is
//     dogfood-H's noise category — should be filtered.
const TEMP_SID = 'ddddddd4-4444-4444-4444-444444444444';
const TEMP_CWD = path.join(os.tmpdir(), 'agentory-probe-spawn-fixture');
// Encode the cwd the way the CLI would (every non-alnum → '-').
const tempProjDir = TEMP_CWD.replace(/[^a-zA-Z0-9]/g, '-');
plantSession(tempProjDir, TEMP_SID, [
  {
    type: 'user',
    parentUuid: null,
    isSidechain: false,
    uuid: 'u-temp-1',
    cwd: TEMP_CWD,
    sessionId: TEMP_SID,
    timestamp: TS,
    message: { role: 'user', content: [{ type: 'text', text: 'PROBE_TEMP_LEAK' }] }
  }
]);

console.log(`[probe] planted 4 fixtures under ${projectsRoot}`);

// ─── Launch the app with a sandboxed HOME ──────────────────────────────────
const ud = isolatedUserData('agentory-probe-import-userdata');

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1',
    HOME: fakeHome,
    USERPROFILE: fakeHome,
    CLAUDE_HOME: fakeHome
  }
});

try { // ccsm-probe-cleanup-wrap

const errors = [];
const win = await appWindow(app);
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');
await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15_000 });

// Force a known starting state.
await win.evaluate(() => {
  window.__ccsmStore.setState({
    sessions: [],
    groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
    activeId: '',
    tutorialSeen: true
  });
});
await win.waitForTimeout(300);

const sessionsBefore = await win.evaluate(() => window.__ccsmStore.getState().sessions.length);
if (sessionsBefore !== 0) {
  await app.close();
  fail(`expected 0 sessions before import, got ${sessionsBefore}`);
}

// 1. Click the sidebar Import button.
const importBtn = win.locator('aside').getByRole('button', { name: /import session/i }).first();
await importBtn.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
  const html = await win.evaluate(() => document.body.innerText.slice(0, 800));
  console.error('--- body text ---\n' + html);
  await app.close();
  fail('sidebar Import button not visible');
});
await importBtn.click();

// 2. Wait for dialog content to render.
await win.waitForTimeout(500);

// ─── Case 2 + Case 3: only the clean fixture should appear ────────────────
const visibleSids = await win.evaluate(() => {
  const text = document.body.innerText;
  return {
    clean: text.includes('PROBE_USER_TEXT_HELLO'),
    sub: text.includes('PROBE_SUBAGENT_LEAK'),
    side: text.includes('PROBE_SIDECHAIN_LEAK'),
    temp: text.includes('PROBE_TEMP_LEAK'),
    fullText: text.slice(0, 2000)
  };
});

if (!visibleSids.clean) {
  console.error('--- dialog text ---\n' + visibleSids.fullText);
  await app.close();
  fail('clean fixture row never appeared in ImportDialog (Case 1 setup failure)');
}
if (visibleSids.sub) {
  await app.close();
  fail('Bug B regression: sub-agent (parentUuid) transcript leaked into import list');
}
if (visibleSids.side) {
  await app.close();
  fail('Bug B regression: sidechain transcript leaked into import list');
}
if (visibleSids.temp) {
  await app.close();
  fail('Bug C regression: agentory-temp cwd transcript leaked into import list');
}
console.log('[probe] case 2+3 OK: only clean fixture visible (sub-agent + sidechain + agentory-temp filtered)');

// ─── Case 1: import the clean fixture and verify history is hydrated ──────
const fixtureRow = win.getByText('PROBE_USER_TEXT_HELLO').first();
await fixtureRow.click();
await win.waitForTimeout(150);

const confirmBtn = win.getByRole('button', { name: /^Import 1$/ });
await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
await confirmBtn.click();

// Wait for the imported session to appear AND for its messagesBySession entry
// to be hydrated from the .jsonl (Bug A — the regression was that this stayed
// empty until the user sent a follow-up).
await win.waitForFunction(
  () => {
    const s = window.__ccsmStore.getState();
    if (s.sessions.length !== 1) return false;
    const id = s.sessions[0].id;
    const msgs = s.messagesBySession[id];
    return Array.isArray(msgs) && msgs.length >= 2;
  },
  null,
  { timeout: 8000 }
).catch(async () => {
  const dump = await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    return {
      sessions: s.sessions,
      messagesBySession: s.messagesBySession
    };
  });
  console.error('--- store after import ---\n' + JSON.stringify(dump, null, 2));
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('Bug A regression: imported session did not hydrate history blocks from .jsonl');
});

const hydrated = await win.evaluate(() => {
  const s = window.__ccsmStore.getState();
  const sid = s.sessions[0].id;
  return {
    sid,
    blocks: s.messagesBySession[sid].map((b) => ({ kind: b.kind, text: b.text }))
  };
});
const hasUser = hydrated.blocks.some((b) => b.kind === 'user' && /PROBE_USER_TEXT_HELLO/.test(b.text ?? ''));
const hasAssistant = hydrated.blocks.some((b) => b.kind === 'assistant' && /PROBE_ASSISTANT_TEXT_REPLY/.test(b.text ?? ''));
if (!hasUser || !hasAssistant) {
  console.error('--- hydrated blocks ---\n' + JSON.stringify(hydrated.blocks, null, 2));
  await app.close();
  fail(`Bug A: hydrated blocks missing expected text (user=${hasUser}, assistant=${hasAssistant})`);
}
console.log('[probe] case 1 OK: imported session hydrated user + assistant blocks from .jsonl');

console.log('\n[probe-e2e-import-session] OK');
console.log('  case 1 (Bug A): history blocks hydrated immediately on import');
console.log('  case 2 (Bug B): sub-agent (parentUuid) + sidechain (isSidechain) filtered');
console.log('  case 3 (Bug C): agentory-temp cwd transcripts filtered');

await app.close();

try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
try { fs.rmSync(ud.dir, { recursive: true, force: true }); } catch {}
} finally { try { await app.close(); } catch {} } // ccsm-probe-cleanup-wrap
