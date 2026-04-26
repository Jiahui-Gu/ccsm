// Themed harness — RESTORE / LIFECYCLE cluster.
//
// Per docs/e2e/single-harness-brainstorm.md §8 + the five-bucket migration
// plan. This is the "lifecycle / persistence" bucket — every absorbed probe
// genuinely needs at least one of:
//   - multi-launch (seed → close → relaunch into the SAME user-data dir)
//   - pre-launch fs/env mutation that the runner can't apply after boot
//   - process-level fixture (renaming a node_modules dep, sandboxing $HOME)
//
// All cases run with `skipLaunch: true` and manage their own electron
// lifecycle inside the case body. The harness-runner capability set
// (#335 — userDataDir:'fresh' / relaunch / preMain) does not currently
// expose the allocated user-data dir to the case body, so the
// "two launches into the SAME dir" pattern (the whole point of the
// restore probes) is implemented directly in each case. The harness still
// gives us:
//   - shared `--only=<id>` filter
//   - per-case [case=<id>] log prefix
//   - per-case trace artifact / failure screenshot scaffolding (no-op for
//     skipLaunch but the runner still wires the disposers)
//   - one CI-discovered file instead of N
//
// Scope (9 cases):
//   - restore                            (seed JSONL fixture, 2-launch)
//   - restore-journey-plan               (ExitPlanMode tool_use, 2-launch)
//   - restore-journey-question           (AskUserQuestion suppression, 2-launch)
//   - sidebar-resize                     (drag + persistence, 2-launch)
//   - sidebar-rename-dnd-state           (J8..J17, 3-launch)
//   - db-corruption-recovery             (pre-launch garbage-write to ccsm.db)
//   - notify-fallback                    (pre-launch node_modules rename + sandboxed HOME)
//   - import-session                     (pre-launch HOME sandboxing + multi-fixture plant)
//   - permission-prompt-default-mode     (2-launch + sandboxed CLAUDE_CONFIG_DIR + real claude.exe)
//
// Bucket-7 cleanup-pass classifications:
//   - restore-session-undo, restore-group-undo, askuserquestion-full,
//     sidebar-journey-create-delete   → harness-agent (single-launch,
//     pure-store; original "restore-*" naming was misleading)
//   - permission-prompt-default-mode  → THIS harness (multi-launch with
//     pre-launch CLAUDE_CONFIG_DIR sandbox; can't fold into harness-agent
//     because the runner doesn't allow per-case env overrides)
//   - streaming-partial-frames        → KEPT in harness-agent (push back on
//     桶 4 reviewer's harness-real-cli reclassification: the case asserts
//     on Electron renderer state — chat-thinking-dots, window.__probeFrames
//     subscription via window.ccsm.onAgentEvent — and harness-real-cli
//     boots no Electron at all, only spawns claude.exe directly)
//
// Probes named in planning but absent from the tree (no action):
//   - restore-journey-permission, tray (no source file ever existed)
//
// Run: `node scripts/harness-restore.mjs`
// Run one case: `node scripts/harness-restore.mjs --only=restore`

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runHarness } from './probe-helpers/harness-runner.mjs';
import { appWindow, dndDrag, isolatedClaudeConfigDir, isolatedUserData, seedStore, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

// ──────────────────────────────────────────────────────────────────────────
// Shared helpers — pulled out so the per-case bodies stay readable.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Slug rule used by `~/.claude/projects/<slug(cwd)>` — replaces /, \, : with -.
 * Matches jsonl-loader.ts (electron/agent-sdk).
 */
function projectKeyFromCwd(cwd) {
  return cwd.replace(/[\\/:]/g, '-');
}

/**
 * Plant a JSONL transcript at the path the renderer's `loadHistory(cwd, sid)`
 * resolves to. Returns a `{ projectDir, jsonlPath, cleanup() }` so the case
 * body can `registerDispose(rec.cleanup)`. Caller must dispose — the planted
 * dir lives under the user's REAL `~/.claude/projects/` (jsonl-loader.ts
 * uses `os.homedir()` directly and doesn't honor HOME overrides for that
 * lookup), so leftover fixtures pollute the developer's CCSM.
 */
function plantJsonlFixture({ cwd, sessionId, frames }) {
  const projectsRoot = path.join(os.homedir(), '.claude', 'projects');
  const projectKey = projectKeyFromCwd(cwd);
  const projectDir = path.join(projectsRoot, projectKey);
  fs.mkdirSync(projectDir, { recursive: true });
  const jsonlPath = path.join(projectDir, `${sessionId}.jsonl`);
  fs.writeFileSync(jsonlPath, frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  return {
    projectDir,
    jsonlPath,
    cleanup() {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* swallow */ }
    }
  };
}

/**
 * Standard launch wrapper that mirrors what the absorbed probes used:
 *   - CCSM_PROD_BUNDLE=1 so main loadFile()s the prebuilt bundle
 *   - `.` cwd + `--user-data-dir=<dir>`
 *
 * Caller passes any extra env (HOME sandboxing, NODE_ENV override, etc.).
 */
async function launch({ userDataDir, env = {}, extraArgs = [] }) {
  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`, ...extraArgs],
    cwd: ROOT,
    env: { ...process.env, CCSM_PROD_BUNDLE: '1', ...env }
  });
  return app;
}

/**
 * appWindow + domcontentloaded + store-hydrated wait. The store wait matches
 * what every absorbed probe inlined manually.
 */
async function waitReady(app) {
  const win = await appWindow(app);
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(
    () => !!window.__ccsmStore,
    null,
    { timeout: 20_000 }
  );
  return win;
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: restore
// 2-launch. Seeds sidebar tree + JSONL fixture, relaunches, asserts the
// active session hydrates from disk including custom group, draft, and
// assistant marker. From probe-e2e-restore.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseRestore({ log, registerDispose }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  const SESSION_ID = 'a1b1c1d1-0000-4000-8000-000000000001';
  const CUSTOM_GROUP_ID = 'g-custom-restore';
  const CUSTOM_GROUP_NAME = 'Probe Custom Group';
  const SESSION_NAME = 'Probe session';
  const DRAFT_TEXT = 'half-typed across restart — keep me alive';
  const ASSISTANT_MARKER = 'RESTORED ASSISTANT MARKER';
  const USER_MARKER = 'hello from probe';

  const fixtureCwdParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-cwd-'));
  registerDispose(() => { try { fs.rmSync(fixtureCwdParent, { recursive: true, force: true }); } catch {} });
  const fixtureCwd = path.join(fixtureCwdParent, 'project');
  fs.mkdirSync(fixtureCwd, { recursive: true });

  const TS = new Date().toISOString();
  const fixture = plantJsonlFixture({
    cwd: fixtureCwd,
    sessionId: SESSION_ID,
    frames: [
      {
        type: 'user', parentUuid: null, isSidechain: false, uuid: 'u-restore-1',
        cwd: fixtureCwd, sessionId: SESSION_ID, timestamp: TS,
        message: { role: 'user', content: [{ type: 'text', text: USER_MARKER }] }
      },
      {
        type: 'assistant', session_id: SESSION_ID, parentUuid: 'u-restore-1', isSidechain: false,
        uuid: 'a-restore-1', cwd: fixtureCwd, timestamp: TS,
        message: {
          id: 'msg-restore-1', role: 'assistant', model: 'claude-opus-4',
          content: [{ type: 'text', text: ASSISTANT_MARKER }]
        }
      }
    ]
  });
  registerDispose(fixture.cleanup);
  log(`planted JSONL fixture at ${fixture.jsonlPath}`);

  // ── Launch #1: seed.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      await win.waitForTimeout(1500);
      const seeded = await win.evaluate(
        async ({ sid, gid, gname, sname, draft, cwd }) => {
          const api = window.ccsm;
          if (!api) return { ok: false, err: 'no window.ccsm' };
          const state = {
            version: 1,
            sessions: [
              { id: sid, name: sname, state: 'idle', cwd, model: 'claude-opus-4', groupId: gid, agentType: 'claude-code' }
            ],
            groups: [
              { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' },
              { id: gid, name: gname, collapsed: false, kind: 'normal' }
            ],
            activeId: sid,
            model: 'claude-opus-4',
            permission: 'auto',
            sidebarCollapsed: false,
            theme: 'system',
            fontSize: 'md',
            recentProjects: [],
            tutorialSeen: true
          };
          await api.saveState('main', JSON.stringify(state));
          await api.saveState('drafts', JSON.stringify({ version: 1, drafts: { [sid]: draft } }));
          const hist = await api.loadHistory(cwd, sid);
          return {
            ok: true,
            histOk: !!hist?.ok,
            frames: hist?.ok ? hist.frames.length : 0,
            err: hist?.ok ? null : hist?.error
          };
        },
        { sid: SESSION_ID, gid: CUSTOM_GROUP_ID, gname: CUSTOM_GROUP_NAME, sname: SESSION_NAME, draft: DRAFT_TEXT, cwd: fixtureCwd }
      );
      if (!seeded.ok) throw new Error(`seed failed: ${seeded.err}`);
      if (!seeded.histOk || seeded.frames !== 2) {
        throw new Error(`loadHistory roundtrip wrong: ok=${seeded.histOk} frames=${seeded.frames} err=${seeded.err}`);
      }
      log('launch #1: seeded sidebar tree + draft; verified JSONL roundtrip via loadHistory');
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }

  // ── Launch #2: assert restoration.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      const errors = [];
      win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
      win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
      await win.waitForTimeout(1500);

      const customGroupLabel = win.getByText(CUSTOM_GROUP_NAME).first();
      try {
        await customGroupLabel.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        const body = await win.evaluate(() => document.body.innerText.slice(0, 1500));
        throw new Error(`custom group "${CUSTOM_GROUP_NAME}" not rendered after restart. body=${body}`);
      }

      const sidebarItem = win.getByText(SESSION_NAME).first();
      try {
        await sidebarItem.waitFor({ state: 'visible', timeout: 5_000 });
      } catch {
        throw new Error(`sidebar session "${SESSION_NAME}" not visible after restart`);
      }

      const marker = win.getByText(ASSISTANT_MARKER).first();
      try {
        await marker.waitFor({ state: 'visible', timeout: 8_000 });
      } catch {
        const dump = await win.evaluate(() => {
          const main = document.querySelector('main');
          return main ? main.innerText.slice(0, 1500) : '<no <main>>';
        });
        throw new Error(`active session history did not auto-render from JSONL. main=${dump} errors=${errors.slice(-10).join('|')}`);
      }

      const userEcho = win.getByText(USER_MARKER).first();
      if (!(await userEcho.isVisible().catch(() => false))) {
        throw new Error('user message from previous session not rendered on restore');
      }

      const textarea = win.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 5000 });
      const draftAfterRestart = await textarea.inputValue();
      if (draftAfterRestart !== DRAFT_TEXT) {
        throw new Error(`draft did not survive app restart. expected=${JSON.stringify(DRAFT_TEXT)} got=${JSON.stringify(draftAfterRestart)}`);
      }

      // Bonus: clicking the session is still safe (re-asserts marker).
      await sidebarItem.click();
      if (!(await marker.isVisible().catch(() => false))) {
        throw new Error('clicking the active session erased its rendered history');
      }
      log(`restored: group + session + history (${ASSISTANT_MARKER}) + draft`);
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: restore-journey-plan
// 2-launch. Asserts ExitPlanMode tool_use survives JSONL roundtrip as a
// regular tool block (not waiting/plan card). From probe-e2e-restore-journey-plan.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseRestoreJourneyPlan({ log, registerDispose }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-plan-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  const SESSION_ID = 'a1b1c1d1-0000-4000-8000-0000000plan1';
  const GROUP_ID = 'g-plan-restore';
  const GROUP_NAME = 'Probe Plan Group';
  const SESSION_NAME = 'Probe plan session';
  const TOOL_USE_ID = 'toolu_plan_restore_1';
  const PLAN_MARKER = 'PLAN-MARKER-RESTORE-XYZ';
  const PLAN_TEXT = `## Restore-plan probe\n\n1. Verify plan persistence\n2. ${PLAN_MARKER}\n3. Done`;

  const fixtureCwdParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-plan-cwd-'));
  registerDispose(() => { try { fs.rmSync(fixtureCwdParent, { recursive: true, force: true }); } catch {} });
  const fixtureCwd = path.join(fixtureCwdParent, 'project');
  fs.mkdirSync(fixtureCwd, { recursive: true });

  const TS = new Date().toISOString();
  const fixture = plantJsonlFixture({
    cwd: fixtureCwd,
    sessionId: SESSION_ID,
    frames: [
      {
        type: 'user', parentUuid: null, isSidechain: false, uuid: 'u-plan-1',
        cwd: fixtureCwd, sessionId: SESSION_ID, timestamp: TS,
        message: { role: 'user', content: [{ type: 'text', text: 'plan a refactor' }] }
      },
      {
        type: 'assistant', session_id: SESSION_ID, parentUuid: 'u-plan-1', isSidechain: false,
        uuid: 'a-plan-1', cwd: fixtureCwd, timestamp: TS,
        message: {
          id: 'msg-plan-1', role: 'assistant', model: 'claude-opus-4',
          content: [{ type: 'tool_use', id: TOOL_USE_ID, name: 'ExitPlanMode', input: { plan: PLAN_TEXT } }]
        }
      }
    ]
  });
  registerDispose(fixture.cleanup);

  // Launch #1.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      await win.waitForTimeout(1500);
      const seeded = await win.evaluate(
        async ({ sid, gid, gname, sname, cwd }) => {
          const api = window.ccsm;
          if (!api) return { ok: false };
          const state = {
            version: 1,
            sessions: [{ id: sid, name: sname, state: 'idle', cwd, model: 'claude-opus-4', groupId: gid, agentType: 'claude-code' }],
            groups: [
              { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' },
              { id: gid, name: gname, collapsed: false, kind: 'normal' }
            ],
            activeId: sid, model: 'claude-opus-4', permission: 'auto', sidebarCollapsed: false,
            theme: 'system', fontSize: 'md', recentProjects: [], tutorialSeen: true
          };
          await api.saveState('main', JSON.stringify(state));
          const hist = await api.loadHistory(cwd, sid);
          return { ok: true, histOk: !!hist?.ok, frames: hist?.ok ? hist.frames.length : 0 };
        },
        { sid: SESSION_ID, gid: GROUP_ID, gname: GROUP_NAME, sname: SESSION_NAME, cwd: fixtureCwd }
      );
      if (!seeded.ok || !seeded.histOk || seeded.frames !== 2) {
        throw new Error(`seed/loadHistory roundtrip failed: ${JSON.stringify(seeded)}`);
      }
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }

  // Launch #2.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      const errors = [];
      win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
      win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
      await win.waitForTimeout(1500);

      const toolName = win.locator('[data-type-scale-role="tool-name"]', { hasText: 'ExitPlanMode' }).first();
      try {
        await toolName.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        const dump = await win.evaluate(() => {
          const main = document.querySelector('main');
          return main ? main.innerText.slice(0, 1500) : '<no <main>>';
        });
        throw new Error(`ExitPlanMode tool block did not hydrate from JSONL. main=${dump} errors=${errors.slice(-10).join('|')}`);
      }

      const planInStore = await win.evaluate((sid) => {
        const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
        const tool = blocks.find((b) => b.kind === 'tool' && b.name === 'ExitPlanMode');
        return tool ? tool.input?.plan ?? null : null;
      }, SESSION_ID);
      if (typeof planInStore !== 'string' || !planInStore.includes(PLAN_MARKER)) {
        throw new Error(`plan input did not survive JSONL roundtrip: got ${JSON.stringify(planInStore?.slice?.(0, 80))}`);
      }

      const noWaiting = await win.evaluate((sid) => {
        const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
        return !blocks.some((b) => b.kind === 'waiting');
      }, SESSION_ID);
      if (!noWaiting) {
        throw new Error('a waiting/plan block leaked into restored session — should be tool block only');
      }
      log(`ExitPlanMode tool block hydrated; plan input preserved; no waiting-block leak`);
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: restore-journey-question
// 2-launch. Asserts AskUserQuestion-shaped JSONL frames are SUPPRESSED on
// restore (no live card / waiting / fallback tool block). From
// probe-e2e-restore-journey-question.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseRestoreJourneyQuestion({ log, registerDispose }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-q-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  const SESSION_ID = 'a1b1c1d1-0000-4000-8000-00000000ques1';
  const GROUP_ID = 'g-q-restore';
  const GROUP_NAME = 'Probe Question Group';
  const SESSION_NAME = 'Probe question session';
  const TOOL_USE_ID = 'toolu_aq_restore_1';
  const QUESTION_OPTION_LABEL = 'OPTION-LABEL-FROM-DEAD-CARD';
  const FOLLOWUP_MARKER = 'FOLLOWUP-MARKER-AFTER-AQ';
  const USER_PROMPT_MARKER = 'before-asking-the-question';

  const fixtureCwdParent = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-restore-q-cwd-'));
  registerDispose(() => { try { fs.rmSync(fixtureCwdParent, { recursive: true, force: true }); } catch {} });
  const fixtureCwd = path.join(fixtureCwdParent, 'project');
  fs.mkdirSync(fixtureCwd, { recursive: true });

  const TS = new Date().toISOString();
  const fixture = plantJsonlFixture({
    cwd: fixtureCwd,
    sessionId: SESSION_ID,
    frames: [
      {
        type: 'user', parentUuid: null, isSidechain: false, uuid: 'u-q-1',
        cwd: fixtureCwd, sessionId: SESSION_ID, timestamp: TS,
        message: { role: 'user', content: [{ type: 'text', text: USER_PROMPT_MARKER }] }
      },
      {
        type: 'assistant', session_id: SESSION_ID, parentUuid: 'u-q-1', isSidechain: false,
        uuid: 'a-q-1', cwd: fixtureCwd, timestamp: TS,
        message: {
          id: 'msg-q-1', role: 'assistant', model: 'claude-opus-4',
          content: [{
            type: 'tool_use', id: TOOL_USE_ID, name: 'AskUserQuestion',
            input: {
              questions: [{
                question: 'Pick one', header: 'Pick', multiSelect: false,
                options: [
                  { label: QUESTION_OPTION_LABEL, description: 'choice A' },
                  { label: 'Option B', description: 'choice B' }
                ]
              }]
            }
          }]
        }
      },
      {
        type: 'user', parentUuid: 'a-q-1', isSidechain: false, uuid: 'u-q-2',
        cwd: fixtureCwd, sessionId: SESSION_ID, timestamp: TS,
        message: {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: TOOL_USE_ID, content: `Pick: ${QUESTION_OPTION_LABEL}` }]
        }
      },
      {
        type: 'assistant', session_id: SESSION_ID, parentUuid: 'u-q-2', isSidechain: false,
        uuid: 'a-q-2', cwd: fixtureCwd, timestamp: TS,
        message: {
          id: 'msg-q-2', role: 'assistant', model: 'claude-opus-4',
          content: [{ type: 'text', text: FOLLOWUP_MARKER }]
        }
      }
    ]
  });
  registerDispose(fixture.cleanup);

  // Launch #1.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      await win.waitForTimeout(1500);
      const seeded = await win.evaluate(
        async ({ sid, gid, gname, sname, cwd }) => {
          const api = window.ccsm;
          if (!api) return { ok: false };
          const state = {
            version: 1,
            sessions: [{ id: sid, name: sname, state: 'idle', cwd, model: 'claude-opus-4', groupId: gid, agentType: 'claude-code' }],
            groups: [
              { id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' },
              { id: gid, name: gname, collapsed: false, kind: 'normal' }
            ],
            activeId: sid, model: 'claude-opus-4', permission: 'auto', sidebarCollapsed: false,
            theme: 'system', fontSize: 'md', recentProjects: [], tutorialSeen: true
          };
          await api.saveState('main', JSON.stringify(state));
          const hist = await api.loadHistory(cwd, sid);
          return { ok: true, frames: hist?.ok ? hist.frames.length : 0 };
        },
        { sid: SESSION_ID, gid: GROUP_ID, gname: GROUP_NAME, sname: SESSION_NAME, cwd: fixtureCwd }
      );
      if (!seeded.ok || seeded.frames !== 4) {
        throw new Error(`seed/loadHistory roundtrip failed: ${JSON.stringify(seeded)}`);
      }
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }

  // Launch #2.
  {
    const app = await launch({ userDataDir });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      const errors = [];
      win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
      win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
      await win.waitForTimeout(1500);

      const followup = win.getByText(FOLLOWUP_MARKER).first();
      try {
        await followup.waitFor({ state: 'visible', timeout: 10_000 });
      } catch {
        const dump = await win.evaluate(() => {
          const main = document.querySelector('main');
          return main ? main.innerText.slice(0, 1500) : '<no <main>>';
        });
        throw new Error(`assistant follow-up after AskUserQuestion did not hydrate. main=${dump} errors=${errors.slice(-10).join('|')}`);
      }

      const userPrompt = win.getByText(USER_PROMPT_MARKER).first();
      if (!(await userPrompt.isVisible().catch(() => false))) {
        throw new Error('opening user message did not render on restart');
      }

      const liveOption = win.locator('[data-question-option]').first();
      if (await liveOption.isVisible().catch(() => false)) {
        throw new Error('a live question card leaked from JSONL — AskUserQuestion suppression contract broken');
      }

      const projection = await win.evaluate((sid) => {
        const blocks = window.__ccsmStore?.getState?.()?.messagesBySession?.[sid] ?? [];
        return {
          kinds: blocks.map((b) => b.kind),
          hasQuestion: blocks.some((b) => b.kind === 'question'),
          hasWaiting: blocks.some((b) => b.kind === 'waiting'),
          hasAQTool: blocks.some((b) => b.kind === 'tool' && b.name === 'AskUserQuestion')
        };
      }, SESSION_ID);
      if (projection.hasQuestion) throw new Error(`question block leaked: ${JSON.stringify(projection)}`);
      if (projection.hasWaiting) throw new Error(`waiting block leaked: ${JSON.stringify(projection)}`);
      if (projection.hasAQTool) throw new Error(`AskUserQuestion fell through to tool block: ${JSON.stringify(projection)}`);
      log(`AskUserQuestion suppressed; surrounding turns rendered. kinds=${JSON.stringify(projection.kinds)}`);
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: sidebar-resize
// 2-launch. Drags the resizer, asserts clamp + double-click reset, picks a
// non-default width, restarts, asserts the width survives.
// From probe-e2e-sidebar-resize.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseSidebarResize({ log, registerDispose }) {
  const ud = isolatedUserData('ccsm-harness-sidebar-resize');
  registerDispose(ud.cleanup);

  // Opt out of CCSM_E2E_HIDDEN: the drag readback assertion needs the
  // resize observer + layout pipeline to run synchronously with pointermove
  // dispatch. With show:true off-screen the layout occasionally lags by a
  // frame and the readback comparison flakes (~5-10% under run-all-e2e).
  const env = { CCSM_E2E_HIDDEN: '0' };

  const asideWidth = (win) => win.evaluate(() => {
    const a = document.querySelector('aside');
    return a ? Math.round(a.getBoundingClientRect().width) : -1;
  });
  const storeWidth = (win) => win.evaluate(() => window.__ccsmStore.getState().sidebarWidth);
  const constants = (win) => win.evaluate(() => {
    const s = window.__ccsmStore;
    const before = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(99999);
    const max = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(0);
    const min = s.getState().sidebarWidth;
    s.getState().setSidebarWidth(before);
    return { min, max };
  });

  let chosenWidth;

  // Launch #1.
  {
    const app = await launch({ userDataDir: ud.dir, env });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      await win.waitForFunction(() => document.querySelector('aside') !== null, null, { timeout: 20_000 });

      const { min, max } = await constants(win);
      const initialW = await asideWidth(win);
      const initialStore = await storeWidth(win);
      if (initialW <= 0) throw new Error(`fixture: aside width <=0 (${initialW})`);

      const resizer = win.locator('div[role="separator"][aria-orientation="vertical"]').first();
      await resizer.waitFor({ state: 'visible', timeout: 3000 });
      const rb = await resizer.boundingBox();
      if (!rb) throw new Error('resizer has no bounding box');
      const startX = rb.x + rb.width / 2;
      const y = rb.y + rb.height / 2;

      // Case 1: drag right by +60px.
      await win.mouse.move(startX, y);
      await win.mouse.down();
      await win.mouse.move(startX + 60, y, { steps: 10 });
      await win.mouse.up();
      await win.waitForTimeout(500);
      const grownStore = await storeWidth(win);
      const grownDom = await asideWidth(win);
      if (Math.abs(grownStore - (initialStore + 60)) > 2) {
        throw new Error(`drag +60: storeWidth expected ~${initialStore + 60}, got ${grownStore}`);
      }
      if (Math.abs(grownDom - grownStore) > 4) {
        throw new Error(`drag +60: aside DOM ${grownDom} doesn't track storeWidth ${grownStore}`);
      }

      // Case 2: drag past max → clamps at max.
      const winSize = await win.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
      const rb2 = await resizer.boundingBox();
      const startX2 = rb2.x + rb2.width / 2;
      await resizer.dispatchEvent('pointerdown', {
        button: 0, clientX: startX2, clientY: y, pointerType: 'mouse', pointerId: 1, isPrimary: true
      });
      const endX2 = winSize.w - 4;
      for (let i = 1; i <= 25; i++) {
        const px = startX2 + ((endX2 - startX2) * i) / 25;
        await win.evaluate(({ px, y }) => document.dispatchEvent(new PointerEvent('pointermove', {
          clientX: px, clientY: y, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true
        })), { px, y });
        await win.waitForTimeout(8);
      }
      await win.evaluate(({ x, y }) => document.dispatchEvent(new PointerEvent('pointerup', {
        clientX: x, clientY: y, bubbles: true, pointerType: 'mouse', pointerId: 1, isPrimary: true
      })), { x: endX2, y });
      await win.waitForTimeout(200);
      const clamped = await storeWidth(win);
      if (clamped !== max) throw new Error(`drag past max: expected ${max}, got ${clamped}`);

      // Case 3: double-click reset.
      const defaultW = await win.evaluate(() => {
        const s = window.__ccsmStore;
        s.getState().resetSidebarWidth();
        return s.getState().sidebarWidth;
      });
      await win.evaluate((w) => window.__ccsmStore.getState().setSidebarWidth(w + 80), defaultW);
      await win.waitForTimeout(500);
      await resizer.dblclick();
      await win.waitForTimeout(300);
      const reset = await storeWidth(win);
      if (reset !== defaultW) throw new Error(`double-click reset: expected ${defaultW}, got ${reset}`);

      // Case 4: pick + persist.
      chosenWidth = Math.min(max, Math.max(min, defaultW + 73));
      await win.evaluate((w) => window.__ccsmStore.getState().setSidebarWidth(w), chosenWidth);
      await win.waitForTimeout(1500); // wait for schedulePersist debounce flush
      const finalStore = await storeWidth(win);
      if (finalStore !== chosenWidth) throw new Error(`pre-quit storeWidth expected ${chosenWidth}, got ${finalStore}`);
      log(`launch #1: drag/clamp/reset OK, chose width=${chosenWidth}`);
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }

  // Launch #2: same userData → restored width.
  {
    const app = await launch({ userDataDir: ud.dir, env });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });
    try {
      const win = await waitReady(app);
      await win.waitForFunction(() => document.querySelector('aside') !== null, null, { timeout: 20_000 });
      const restored = await storeWidth(win);
      const restoredDom = await asideWidth(win);
      if (restored !== chosenWidth) throw new Error(`after restart: storeWidth expected ${chosenWidth}, got ${restored}`);
      if (Math.abs(restoredDom - chosenWidth) > 4) {
        throw new Error(`after restart: aside DOM ${restoredDom} doesn't match restored store ${chosenWidth}`);
      }
      log(`launch #2: restored width=${restored} (DOM=${restoredDom})`);
    } finally {
      closed = true;
      try { await app.close(); } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: db-corruption-recovery
// Pre-launch FS fixture: write 256 random bytes to <userDataDir>/ccsm.db
// before electron boots, then assert the renderer mounts and a backup file
// is written. From probe-e2e-db-corruption-recovery.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseDbCorruptionRecovery({ log, registerDispose }) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-db-corrupt-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  // Pre-seed garbage at the canonical db path.
  const dbFile = path.join(userDataDir, 'ccsm.db');
  fs.writeFileSync(dbFile, crypto.randomBytes(256));

  const app = await launch({ userDataDir });
  let closed = false;
  registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });

  // Surface main-process stderr so a crash inside initDb shows up in our
  // log output instead of silently timing out the renderer wait below.
  app.process().stderr?.on('data', (b) => process.stderr.write(`[main-stderr] ${b.toString()}`));

  try {
    let win;
    try {
      win = await appWindow(app);
      await win.waitForLoadState('domcontentloaded');
      await win.waitForFunction(
        () => document.querySelector('aside') !== null || document.querySelector('main button') !== null,
        null,
        { timeout: 15_000 }
      );
    } catch (err) {
      throw new Error(`app failed to boot after pre-corrupted db: ${err?.message ?? err}`);
    }
    await win.waitForTimeout(250);

    const siblings = fs.readdirSync(userDataDir);
    const backups = siblings.filter((n) => n.startsWith('ccsm.db.corrupt-'));
    if (backups.length === 0) {
      throw new Error(`expected ≥1 ccsm.db.corrupt-* backup; saw ${JSON.stringify(siblings)}`);
    }
    if (!fs.existsSync(dbFile)) throw new Error('expected fresh ccsm.db after recovery');
    const header = fs.readFileSync(dbFile).subarray(0, 16);
    const expected = Buffer.concat([Buffer.from('SQLite format 3'), Buffer.from([0])]);
    if (!header.equals(expected)) {
      throw new Error(`new ccsm.db is not a SQLite file; header=${header.toString('hex')}`);
    }
    log(`pre-corrupted ccsm.db; app booted; backup created: ${backups.join(', ')}`);
  } finally {
    closed = true;
    try { await app.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: notify-fallback
// Pre-launch fixture: rename `node_modules/electron-windows-notifications` so
// the WindowsAdapter's require() throws MODULE_NOT_FOUND. Sandboxes HOME so
// the dev's real ~/.claude isn't touched. From probe-e2e-notify-fallback.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseNotifyFallback({ log, registerDispose }) {
  const notifyDir = path.join(ROOT, 'node_modules', 'electron-windows-notifications');
  const stashedDir = path.join(ROOT, 'node_modules', 'electron-windows-notifications.__harness_stash__');

  let stashed = false;
  if (fs.existsSync(notifyDir)) {
    if (fs.existsSync(stashedDir)) {
      fs.rmSync(stashedDir, { recursive: true, force: true });
    }
    fs.renameSync(notifyDir, stashedDir);
    stashed = true;
  }
  registerDispose(() => {
    if (!stashed) return;
    if (!fs.existsSync(notifyDir) && fs.existsSync(stashedDir)) {
      fs.renameSync(stashedDir, notifyDir);
    } else if (fs.existsSync(stashedDir)) {
      // notify dir already restored somehow — just nuke the stash.
      fs.rmSync(stashedDir, { recursive: true, force: true });
    }
  });

  if (fs.existsSync(notifyDir)) {
    throw new Error(`failed to stash node_modules/electron-windows-notifications at ${notifyDir}`);
  }

  // Notify-fallback uses the dev bundle path (NODE_ENV=development +
  // CCSM_DEV_PORT) in the original probe to exercise the same code path the
  // dev sees. We start a tiny static server for the bundle.
  const server = await startBundleServer(ROOT);
  registerDispose(() => server.close());

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-notify-fb-ud-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-notify-fb-home-'));
  registerDispose(() => { try { fs.rmSync(homeDir, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(homeDir, '.claude'), { recursive: true });

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${userDataDir}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      CCSM_DEV_PORT: String(server.port),
      HOME: homeDir,
      USERPROFILE: homeDir
    }
  });
  let closed = false;
  registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });

  const mainErrors = [];
  app.process().on('exit', (code, signal) => {
    if (code !== null && code !== 0) {
      mainErrors.push(`main exited code=${code} signal=${signal}`);
    }
  });

  try {
    const win = await appWindow(app);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 15000 });

    const rendererErrors = [];
    win.on('pageerror', (err) => rendererErrors.push(`pageerror: ${err.message}`));
    win.on('console', (msg) => { if (msg.type() === 'error') rendererErrors.push(`console.error: ${msg.text()}`); });

    const ipcResult = await app.evaluate(async ({ ipcMain }, _arg) => {
      // eslint-disable-next-line no-underscore-dangle
      const handlers = ipcMain._invokeHandlers;
      const fn = handlers.get('notify:availability');
      if (typeof fn !== 'function') return { error: 'handler not registered' };
      return await fn({ sender: null });
    }, null);

    if (!ipcResult || typeof ipcResult !== 'object') {
      throw new Error(`notify:availability did not return an object — got ${JSON.stringify(ipcResult)}`);
    }
    if (ipcResult.available !== false) {
      throw new Error(`expected available=false (module stashed) — got ${JSON.stringify(ipcResult)}`);
    }
    if (typeof ipcResult.error !== 'string' || !ipcResult.error) {
      throw new Error(`expected error to be non-empty string — got ${JSON.stringify(ipcResult)}`);
    }

    const sidebarBtn = win.getByRole('button', { name: /^settings$/i }).first();
    await sidebarBtn.waitFor({ state: 'visible', timeout: 5000 });
    await sidebarBtn.click();

    const dialog = win.getByRole('dialog');
    await dialog.waitFor({ state: 'visible', timeout: 3000 });

    const notifTab = dialog.getByRole('tab', { name: /^notifications$/i });
    await notifTab.waitFor({ state: 'visible', timeout: 2000 });
    await notifTab.click();

    const status = win.locator('[data-testid="notifications-module-status"]');
    await status.waitFor({ state: 'visible', timeout: 3000 });
    await win.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="notifications-module-status"]');
        return el && el.getAttribute('data-available') === 'false';
      },
      null,
      { timeout: 5000 }
    );

    const text = (await status.textContent())?.trim() ?? '';
    if (!text) throw new Error('notifications-module-status indicator was empty');
    const lower = text.toLowerCase();
    if (!lower.includes('native notification module')) {
      throw new Error(`fallback message missing "native notification module": "${text}"`);
    }
    if (!lower.includes('in-app banners')) {
      throw new Error(`fallback message missing "in-app banners": "${text}"`);
    }
    for (const word of text.split(/\s+/)) {
      if (word.length > 3 && /^[A-Z]+$/.test(word) && word !== 'CCSM') {
        throw new Error(`fallback message contains uppercase word "${word}" (no SCREAMING UI): "${text}"`);
      }
    }

    if (rendererErrors.length > 0) throw new Error(`renderer logged errors:\n  ${rendererErrors.join('\n  ')}`);
    if (mainErrors.length > 0) throw new Error(`main process errors:\n  ${mainErrors.join('\n  ')}`);
    log(`Settings banner reads: "${text}"`);
  } finally {
    closed = true;
    try { await app.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: import-session
// Pre-launch fixture: plant 4 JSONL fixtures under a sandboxed HOME, launch
// with HOME/USERPROFILE redirected, drive the Import dialog, assert correct
// filtering (clean session imports; sub-agent + sidechain + ccsm-temp filtered).
// From probe-e2e-import-session.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseImportSession({ log, registerDispose }) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-import-home-'));
  registerDispose(() => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
  const projectsRoot = path.join(fakeHome, '.claude', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });

  const plantSession = (projDirName, sessionId, frames) => {
    const dir = path.join(projectsRoot, projDirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, sessionId + '.jsonl'), frames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  };

  const TS = new Date().toISOString();

  // (1) Clean top-level session.
  const CLEAN_SID = 'aaaaaaa1-1111-1111-1111-111111111111';
  const CLEAN_CWD = '/tmp/probe-fixture-clean';
  plantSession('-tmp-probe-fixture-clean', CLEAN_SID, [
    { type: 'permission-mode', permissionMode: 'default', sessionId: CLEAN_SID },
    {
      type: 'user', parentUuid: null, isSidechain: false, uuid: 'u-clean-1',
      cwd: CLEAN_CWD, sessionId: CLEAN_SID, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'PROBE_USER_TEXT_HELLO' }] }
    },
    {
      type: 'assistant', session_id: CLEAN_SID, parentUuid: 'u-clean-1', isSidechain: false,
      uuid: 'a-clean-1', cwd: CLEAN_CWD, timestamp: TS,
      message: {
        id: 'msg-clean-1', role: 'assistant', model: 'claude-opus-4-7',
        content: [{ type: 'text', text: 'PROBE_ASSISTANT_TEXT_REPLY' }]
      }
    }
  ]);

  // (2) Sub-agent transcript (parentUuid set).
  const SUBAGENT_SID = 'bbbbbbb2-2222-2222-2222-222222222222';
  plantSession('-tmp-probe-fixture-clean', SUBAGENT_SID, [
    {
      type: 'user', parentUuid: 'parent-real-uuid-123', isSidechain: false, uuid: 'u-sub-1',
      cwd: CLEAN_CWD, sessionId: SUBAGENT_SID, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'PROBE_SUBAGENT_LEAK' }] }
    }
  ]);

  // (3) Sidechain transcript.
  const SIDECHAIN_SID = 'ccccccc3-3333-3333-3333-333333333333';
  plantSession('-tmp-probe-fixture-clean', SIDECHAIN_SID, [
    {
      type: 'user', parentUuid: null, isSidechain: true, uuid: 'u-side-1',
      cwd: CLEAN_CWD, sessionId: SIDECHAIN_SID, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'PROBE_SIDECHAIN_LEAK' }] }
    }
  ]);

  // (4) ccsm-temp cwd transcript (Dogfood-H noise).
  const TEMP_SID = 'ddddddd4-4444-4444-4444-444444444444';
  const TEMP_CWD = path.join(os.tmpdir(), 'agentory-probe-spawn-fixture');
  const tempProjDir = TEMP_CWD.replace(/[^a-zA-Z0-9]/g, '-');
  plantSession(tempProjDir, TEMP_SID, [
    {
      type: 'user', parentUuid: null, isSidechain: false, uuid: 'u-temp-1',
      cwd: TEMP_CWD, sessionId: TEMP_SID, timestamp: TS,
      message: { role: 'user', content: [{ type: 'text', text: 'PROBE_TEMP_LEAK' }] }
    }
  ]);

  log(`planted 4 fixtures under ${projectsRoot}`);

  const ud = isolatedUserData('ccsm-harness-import-userdata');
  registerDispose(ud.cleanup);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CCSM_PROD_BUNDLE: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_HOME: fakeHome
    }
  });
  let closed = false;
  registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });

  try {
    const errors = [];
    const win = await appWindow(app);
    win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    win.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });

    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });

    // Force a known starting state — empty sessions + default group only,
    // tutorial dismissed.
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
    if (sessionsBefore !== 0) throw new Error(`expected 0 sessions before import, got ${sessionsBefore}`);

    // Open import dialog via the sidebar Import button.
    const importBtn = win.locator('aside').getByRole('button', { name: /import session/i }).first();
    try {
      await importBtn.waitFor({ state: 'visible', timeout: 10_000 });
    } catch {
      const html = await win.evaluate(() => document.body.innerText.slice(0, 800));
      throw new Error(`sidebar Import button not visible. body=${html}`);
    }
    await importBtn.click();
    await win.waitForTimeout(500);

    // Cases 2+3: only the clean fixture should appear in the dialog.
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
      throw new Error(`clean fixture row never appeared in ImportDialog. dialog=${visibleSids.fullText}`);
    }
    if (visibleSids.sub) throw new Error('Bug B regression: sub-agent (parentUuid) leaked into import list');
    if (visibleSids.side) throw new Error('Bug B regression: sidechain transcript leaked into import list');
    if (visibleSids.temp) throw new Error('Bug C regression: agentory-temp cwd transcript leaked into import list');

    // Case 1: import the clean fixture and verify history hydrates immediately.
    const fixtureRow = win.getByText('PROBE_USER_TEXT_HELLO').first();
    await fixtureRow.click();
    await win.waitForTimeout(150);
    const confirmBtn = win.getByRole('button', { name: /^Import 1$/ });
    await confirmBtn.waitFor({ state: 'visible', timeout: 3000 });
    await confirmBtn.click();

    try {
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
      );
    } catch {
      const dump = await win.evaluate(() => {
        const s = window.__ccsmStore.getState();
        return { sessions: s.sessions, messagesBySession: s.messagesBySession };
      });
      throw new Error(`Bug A regression: imported session did not hydrate history. store=${JSON.stringify(dump)} errors=${errors.slice(-5).join('|')}`);
    }

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
      throw new Error(`Bug A: hydrated blocks missing expected text (user=${hasUser}, assistant=${hasAssistant}); blocks=${JSON.stringify(hydrated.blocks)}`);
    }

    // Task #292: ccsm session.id must equal the JSONL filename UUID. Without
    // this, the SDK's first init frame fires a `session_id_mismatch`
    // diagnostic on resume and the in-app id forever drifts from the
    // on-disk transcript path. Assert both: the id matches the planted
    // sid, and no mismatch diagnostic was pushed during import.
    if (hydrated.sid !== CLEAN_SID) {
      throw new Error(`Task #292 regression: ccsm session.id (${hydrated.sid}) != JSONL filename UUID (${CLEAN_SID})`);
    }
    const mismatchDiagnostics = await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      return (s.diagnostics ?? []).filter((d) => d.code === 'session_id_mismatch');
    });
    if (mismatchDiagnostics.length > 0) {
      throw new Error(`Task #292 regression: session_id_mismatch diagnostic fired during import: ${JSON.stringify(mismatchDiagnostics)}`);
    }
    log(`imported clean session; sub-agent + sidechain + ccsm-temp correctly filtered; ${hydrated.blocks.length} blocks hydrated; ccsm.id == JSONL UUID; no session_id_mismatch`);
  } finally {
    closed = true;
    try { await app.close(); } catch {}
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: sidebar-rename-dnd-state (J8..J17)
// 3-launch (in-line relaunches for J12 + J15 persistence assertions).
// Uses divergence-recording: many sub-journeys, each records mismatches and
// the case fails iff any divergence is observed. From
// probe-e2e-sidebar-journey-rename-dnd-state.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function caseSidebarRenameDndState({ log, registerDispose }) {
  const ud = isolatedUserData('ccsm-harness-sidebar-rds');
  registerDispose(ud.cleanup);

  let app = await launch({ userDataDir: ud.dir });
  let appClosed = false;
  // Track the LIVE app reference for cleanup. The reassignments below
  // (`app = await launch(...)`) need their own disposers, so we drain the
  // disposers manually before each relaunch via a small helper.
  const closeCurrentApp = async () => {
    if (appClosed) return;
    appClosed = true;
    try { await app.close(); } catch {}
  };
  registerDispose(closeCurrentApp);

  let win = await appWindow(app);
  const errors = [];
  const wireErrors = (w) => {
    w.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
    w.on('console', (m) => { if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`); });
  };
  wireErrors(win);
  await win.waitForLoadState('domcontentloaded');

  const divergences = [];
  const diverge = (j, expected, observed) => {
    divergences.push({ j, expected, observed });
    log(`${j} DIVERGE — expected: ${expected} | observed: ${observed}`);
  };

  const stateOf = () => win.evaluate(() => window.__ccsmStore.getState());

  // ── J8/J9 — inline rename behavior (whitespace cancel + duplicates) ──
  await seedStore(win, {
    groups: [{ id: 'gA', name: 'Has Spaces', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 's1', name: 'one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 's2', name: 'two', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 's1',
    focusedGroupId: null
  });
  {
    // J9 — whitespace + Enter on group keeps original.
    const header = win.locator('[data-group-header-id="gA"]').first();
    await header.click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    const gInput = win.locator('[data-group-header-id="gA"] input').first();
    await gInput.waitFor({ state: 'visible', timeout: 3000 });
    await gInput.click();
    await gInput.fill('   ');
    await gInput.press('Enter');
    await win.waitForTimeout(150);
    const after = await stateOf();
    const g = after.groups.find((x) => x.id === 'gA');
    if (g.name !== 'Has Spaces') {
      diverge('J9.whitespace', 'whitespace-only Enter on group cancels (name preserved)', `name became "${g.name}"`);
    } else log(`J9 whitespace-cancel PASS`);

    // J10 — duplicate session names are allowed.
    await win.locator('li[data-session-id="s1"]').first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    const i1 = win.locator('li[data-session-id="s1"] input').first();
    await i1.waitFor({ state: 'visible', timeout: 3000 });
    await i1.click();
    await i1.fill('dupe');
    await i1.press('Enter');
    await win.waitForTimeout(150);

    await win.locator('li[data-session-id="s2"]').first().click({ button: 'right' });
    await win.getByRole('menuitem', { name: /^Rename$/ }).first().click();
    const i2 = win.locator('li[data-session-id="s2"] input').first();
    await i2.waitFor({ state: 'visible', timeout: 3000 });
    await i2.click();
    await i2.fill('dupe');
    await i2.press('Enter');
    await win.waitForTimeout(200);

    const after2 = await stateOf();
    const n1 = after2.sessions.find((s) => s.id === 's1')?.name;
    const n2 = after2.sessions.find((s) => s.id === 's2')?.name;
    if (n1 !== 'dupe' || n2 !== 'dupe') {
      diverge('J10.duplicates', 'both sessions can be named "dupe"', `s1="${n1}", s2="${n2}"`);
    } else log(`J10 duplicates PASS`);
  }

  // ── J11 — header-drop appends to END of target group ────────────────
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
      { id: 'gB', name: 'B', collapsed: false, kind: 'normal' }
    ],
    sessions: [
      { id: 'a1', name: 'a-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'b1', name: 'b-one', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' },
      { id: 'b2', name: 'b-two', state: 'idle', cwd: '~', model: 'm', groupId: 'gB', agentType: 'claude-code' }
    ],
    activeId: 'a1',
    focusedGroupId: null
  });
  {
    await dndDrag(win, 'li[data-session-id="a1"]', '[data-group-header-id="gB"]');
    const idsB = await win.evaluate(() => {
      const ul = document.querySelector('ul[data-group-id="gB"]');
      return ul ? Array.from(ul.querySelectorAll('li[data-session-id]')).map((li) => li.getAttribute('data-session-id')) : null;
    });
    if (!idsB) diverge('J11.dom', 'gB ul exists', 'null');
    else if (idsB[idsB.length - 1] !== 'a1') {
      diverge('J11.appendOnHeader', 'header-drop appends → last id === "a1"', `order=[${idsB.join(',')}]`);
    } else log(`J11 append-on-header PASS — [${idsB.join(',')}]`);
  }

  // ── J12 — in-group reorder (drop on session inserts BEFORE) + persistence
  await seedStore(win, {
    groups: [{ id: 'gA', name: 'A', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 'a1', name: 'a1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a2', name: 'a2', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'a3', name: 'a3', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' }
    ],
    activeId: 'a1',
    focusedGroupId: null
  });
  {
    await dndDrag(win, 'li[data-session-id="a3"]', 'li[data-session-id="a1"]');
    const order = await win.evaluate(() => {
      const ul = document.querySelector('ul[data-group-id="gA"]');
      return ul ? Array.from(ul.querySelectorAll('li[data-session-id]')).map((li) => li.getAttribute('data-session-id')) : null;
    });
    if (!order || order.join(',') !== 'a3,a1,a2') {
      diverge('J12.reorderDom', 'drop a3 on a1 yields [a3,a1,a2]', `[${(order || []).join(',')}]`);
    } else log(`J12.reorderDom PASS — [${order.join(',')}]`);

    // Persistence: force a real moveSession (seedStore uses setState which
    // bypasses the persist subscriber).
    await win.evaluate(() => {
      window.__ccsmStore.getState().moveSession('a2', 'gA', null);
    });
    await win.waitForTimeout(500);
    const preOrder = await win.evaluate(() =>
      window.__ccsmStore.getState().sessions.filter((s) => s.groupId === 'gA').map((s) => s.id)
    );

    await app.close();
    await new Promise((r) => setTimeout(r, 500));
    appClosed = false;
    app = await launch({ userDataDir: ud.dir });
    win = await appWindow(app);
    wireErrors(win);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(
      () => !!window.__ccsmStore && document.querySelector('aside') !== null,
      null,
      { timeout: 20_000 }
    );
    await win.waitForTimeout(400);
    const postOrder = await win.evaluate(() =>
      window.__ccsmStore.getState().sessions.filter((s) => s.groupId === 'gA').map((s) => s.id)
    );
    if (postOrder.join(',') !== preOrder.join(',')) {
      diverge('J12.persistence', `order persists (pre=[${preOrder.join(',')}])`, `post=[${postOrder.join(',')}]`);
    } else log(`J12.persistence PASS — [${postOrder.join(',')}]`);
  }

  // ── J13 — short hover does NOT auto-expand collapsed group ─────────
  await seedStore(win, {
    groups: [
      { id: 'gA', name: 'A', collapsed: false, kind: 'normal' },
      { id: 'gC', name: 'C-collapsed', collapsed: true, kind: 'normal' }
    ],
    sessions: [
      { id: 'd1', name: 'd1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA', agentType: 'claude-code' },
      { id: 'd2', name: 'd2', state: 'idle', cwd: '~', model: 'm', groupId: 'gC', agentType: 'claude-code' }
    ],
    activeId: 'd1',
    focusedGroupId: null
  });
  {
    await dndDrag(win, 'li[data-session-id="d1"]', '[data-group-header-id="gC"]', { holdMs: 0, settleMs: 50 });
    const c = await win.evaluate(() => window.__ccsmStore.getState().groups.find((g) => g.id === 'gC')?.collapsed);
    if (c !== true) diverge('J13.shortHover', 'quick-pass over collapsed group does NOT auto-expand', `collapsed=${c}`);
    else log(`J13 short-hover PASS`);
  }

  // ── J14 — drag onto archived group is rejected ─────────────────────
  await seedStore(win, {
    groups: [
      { id: 'gA',   name: 'Live',     collapsed: false, kind: 'normal' },
      { id: 'gArc', name: 'Archived', collapsed: false, kind: 'archive' }
    ],
    sessions: [
      { id: 'e1', name: 'e1', state: 'idle', cwd: '~', model: 'm', groupId: 'gA',   agentType: 'claude-code' },
      { id: 'e2', name: 'e2', state: 'idle', cwd: '~', model: 'm', groupId: 'gArc', agentType: 'claude-code' }
    ],
    activeId: 'e1',
    focusedGroupId: null
  });
  {
    const archToggle = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
    if (await archToggle.count()) {
      await archToggle.click();
      await win.waitForTimeout(150);
    }
    const archHeader = win.locator('[data-group-header-id="gArc"]');
    if ((await archHeader.count()) === 0) {
      diverge('J14.headerVisible', 'archived header mounted when archive panel open', 'header not in DOM');
    } else {
      await dndDrag(win, 'li[data-session-id="e1"]', '[data-group-header-id="gArc"]');
      const e1Group = await win.evaluate(() =>
        window.__ccsmStore.getState().sessions.find((s) => s.id === 'e1')?.groupId
      );
      if (e1Group === 'gArc') diverge('J14.rejectArchive', 'drag into archived rejected', `e1 moved to "gArc"`);
      else log(`J14 reject-archive PASS — groupId="${e1Group}"`);
    }
  }

  // ── J15 — collapsed flag persists across restart (RELAUNCH #3) ────
  await seedStore(win, {
    groups: [{ id: 'gP', name: 'persisted', collapsed: false, kind: 'normal' }],
    sessions: [{ id: 'p1', name: 'p1', state: 'idle', cwd: '~', model: 'm', groupId: 'gP', agentType: 'claude-code' }],
    activeId: 'p1',
    focusedGroupId: null
  });
  {
    await win.evaluate(() => window.__ccsmStore.getState().setGroupCollapsed('gP', true));
    await win.waitForTimeout(500);
    await app.close();
    await new Promise((r) => setTimeout(r, 500));
    appClosed = false;
    app = await launch({ userDataDir: ud.dir });
    win = await appWindow(app);
    wireErrors(win);
    await win.waitForLoadState('domcontentloaded');
    await win.waitForFunction(
      () => !!window.__ccsmStore && document.querySelector('aside') !== null,
      null,
      { timeout: 20_000 }
    );
    await win.waitForTimeout(400);
    const post = await win.evaluate(() =>
      window.__ccsmStore.getState().groups.find((g) => g.id === 'gP')?.collapsed
    );
    if (post !== true) diverge('J15.collapsedPersist', 'group collapsed=true survives restart', `collapsed=${post}`);
    else log(`J15 collapsed-persist PASS`);
  }

  // ── J16 — archive/unarchive lifecycle ─────────────────────────────
  await seedStore(win, {
    groups: [{ id: 'gAlive', name: 'Live one', collapsed: false, kind: 'normal' }],
    sessions: [
      { id: 'al1', name: 'al1', state: 'idle', cwd: '~', model: 'm', groupId: 'gAlive', agentType: 'claude-code' },
      { id: 'al2', name: 'al2', state: 'idle', cwd: '~', model: 'm', groupId: 'gAlive', agentType: 'claude-code' }
    ],
    activeId: 'al1',
    focusedGroupId: null
  });
  {
    const header = win.locator('[data-group-header-id="gAlive"]').first();
    await header.click({ button: 'right' });
    const archMenu = win.getByRole('menuitem').filter({ hasText: /Archive group/ }).first();
    await archMenu.waitFor({ state: 'visible', timeout: 3000 });
    await archMenu.click();
    await win.waitForTimeout(250);
    const k = await win.evaluate(() => window.__ccsmStore.getState().groups.find((g) => g.id === 'gAlive')?.kind);
    if (k !== 'archive') diverge('J16.kindArchive', `kind === 'archive' after Archive`, `kind="${k}"`);
    const inMainList = await win.evaluate(() => {
      const headers = document.querySelectorAll('[data-group-header-id="gAlive"]');
      if (headers.length === 0) return 'none';
      for (const h of headers) {
        let p = h.parentElement;
        while (p && p.tagName !== 'NAV') p = p.parentElement;
        if (!p) continue;
        if (!p.className.includes('h-40')) return 'main';
      }
      return 'archived';
    });
    if (inMainList === 'main') {
      diverge('J16.notInMain', 'archived group removed from main list', 'still rendered in main <nav>');
    } else if (inMainList === 'none') {
      const arch = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
      if (await arch.count()) {
        await arch.click();
        await win.waitForTimeout(150);
      }
      const recount = await win.locator('[data-group-header-id="gAlive"]').count();
      if (recount === 0) diverge('J16.appearsInArchive', 'archived group renders in Archived panel', 'not in DOM');
    }
    const arch2 = win.locator('aside button[aria-expanded]').filter({ hasText: /Archived/ }).first();
    if (await arch2.count() && (await arch2.getAttribute('aria-expanded')) === 'false') {
      await arch2.click();
      await win.waitForTimeout(150);
    }
    const archHeader = win.locator('[data-group-header-id="gAlive"]').first();
    await archHeader.click({ button: 'right' });
    const unarchMenu = win.getByRole('menuitem').filter({ hasText: /Unarchive group/ }).first();
    await unarchMenu.waitFor({ state: 'visible', timeout: 3000 });
    await unarchMenu.click();
    await win.waitForTimeout(250);
    const k2 = await win.evaluate(() => window.__ccsmStore.getState().groups.find((g) => g.id === 'gAlive')?.kind);
    if (k2 !== 'normal') diverge('J16.unarchive', `unarchive restores kind='normal'`, `kind="${k2}"`);
    else log(`J16 archive/unarchive PASS`);
  }

  // ── J17 — active session highlight + scroll-into-view ────────────
  {
    const many = [];
    for (let i = 0; i < 50; i++) {
      many.push({
        id: `m${i}`, name: `m-${i}`, state: 'idle', cwd: '~', model: 'm',
        groupId: 'gM', agentType: 'claude-code'
      });
    }
    await seedStore(win, {
      groups: [{ id: 'gM', name: 'Many', collapsed: false, kind: 'normal' }],
      sessions: many,
      activeId: 'm0',
      focusedGroupId: null
    });
    await win.waitForTimeout(200);
    const activeAria = await win.locator('li[data-session-id="m0"]').first().getAttribute('aria-selected');
    if (activeAria !== 'true') diverge('J17.highlightAria', 'active row aria-selected="true"', `="${activeAria}"`);
    await win.evaluate(() => window.__ccsmStore.getState().selectSession('m49'));
    await win.waitForTimeout(700);
    const visible = await win.evaluate(() => {
      const li = document.querySelector('li[data-session-id="m49"]');
      if (!li) return { reason: 'no-li' };
      const rect = li.getBoundingClientRect();
      let p = li.parentElement;
      let scroller = null;
      while (p) {
        const st = getComputedStyle(p);
        if (st.overflowY === 'auto' || st.overflowY === 'scroll') { scroller = p; break; }
        p = p.parentElement;
      }
      if (!scroller) return { reason: 'no-scroller' };
      const sRect = scroller.getBoundingClientRect();
      const top = rect.top >= sRect.top - 1;
      const bottom = rect.bottom <= sRect.bottom + 1;
      return { top, bottom, scrollerH: scroller.clientHeight, scrollerScrollTop: scroller.scrollTop, liOffsetTop: li.offsetTop };
    });
    if (visible.reason) diverge('J17.scrollContainer', 'active row in scroll container', `reason=${visible.reason}`);
    else if (!visible.top || !visible.bottom) {
      diverge('J17.scrollIntoView', 'off-screen selection scrolls into view', `top=${visible.top}, bottom=${visible.bottom}`);
    } else log(`J17 highlight + scroll-into-view PASS`);
  }

  log(`divergence count = ${divergences.length}`);
  for (const d of divergences) {
    log(`  ${d.j.padEnd(28)}  expected: ${d.expected}`);
    log(`  ${' '.padEnd(28)}  observed: ${d.observed}`);
  }
  if (divergences.length > 0) {
    throw new Error(`${divergences.length} divergence(s) — see log above`);
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: permission-prompt-default-mode
// 2-launch with sandboxed CLAUDE_CONFIG_DIR (empty allowlist) so the Bash
// permission prompt UI MUST appear. Verifies PreToolUse hook (#94) wires
// can_use_tool through the renderer's <PermissionPromptBlock>.
// Bucket-7 absorption from probe-e2e-permission-prompt-default-mode.mjs.
// ──────────────────────────────────────────────────────────────────────────
async function casePermissionPromptDefaultMode({ log, registerDispose }) {
  const MARKER = 'permhook-perm-test-91827';
  const SESSION_ID = crypto.randomUUID();
  const GROUP_ID = 'g-default';

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-perm-default-'));
  registerDispose(() => { try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {} });

  // Sandbox CLAUDE_CONFIG_DIR — without this, the dev's real ~/.claude
  // settings.json's Bash allowlist could auto-allow the prompt and
  // false-green the assertion.
  const cfg = isolatedClaudeConfigDir('ccsm-harness-perm-default');
  registerDispose(cfg.cleanup);
  log(`sandboxed CLAUDE_CONFIG_DIR = ${cfg.dir}`);

  // Strip CLAUDECODE so the spawned claude.exe doesn't refuse-to-launch
  // with "cannot run inside another Claude Code session".
  const env = {
    ...process.env,
    CCSM_PROD_BUNDLE: '1',
    CCSM_CLAUDE_CONFIG_DIR: cfg.dir,
  };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;

  // Launch #1: seed state via saveState API + close so #2 restores from disk.
  {
    const app1 = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: ROOT,
      env,
    });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app1.close(); } catch {} });
    try {
      const win1 = await appWindow(app1, { timeout: 30_000 });
      await win1.waitForLoadState('domcontentloaded');
      await win1.waitForTimeout(1500);
      const seeded = await win1.evaluate(
        async ({ sid, gid }) => {
          const api = window.ccsm;
          if (!api) return { ok: false, err: 'no window.ccsm' };
          const state = {
            version: 1,
            sessions: [
              { id: sid, name: 'Permission default-mode probe', state: 'idle',
                cwd: '~', model: 'claude-opus-4', groupId: gid, agentType: 'claude-code' },
            ],
            groups: [{ id: gid, name: 'Sessions', collapsed: false, kind: 'normal' }],
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
          return { ok: true };
        },
        { sid: SESSION_ID, gid: GROUP_ID }
      );
      if (!seeded.ok) throw new Error(`seed failed: ${seeded.err}`);
      log('launch #1: state seeded with permission=default');
    } finally {
      try { await app1.close(); closed = true; } catch {}
    }
  }

  // Launch #2: relaunch reads persisted state; drive the Bash prompt.
  {
    const app2 = await electron.launch({
      args: ['.', `--user-data-dir=${userDataDir}`],
      cwd: ROOT,
      env,
    });
    let closed = false;
    registerDispose(async () => { if (!closed) try { await app2.close(); } catch {} });
    try {
      const win2 = await appWindow(app2, { timeout: 30_000 });
      await win2.waitForLoadState('domcontentloaded');
      await win2.waitForTimeout(3500);

      await win2.evaluate((sid) => {
        const s = window.__ccsmStore?.getState();
        if (s && typeof s.selectSession === 'function' && s.activeId !== sid) {
          s.selectSession(sid);
        }
      }, SESSION_ID);
      await win2.waitForTimeout(500);

      const verifyMode = await win2.evaluate(() => {
        const s = window.__ccsmStore?.getState();
        return { permission: s?.permission, activeId: s?.activeId };
      });
      if (verifyMode.permission !== 'default') {
        throw new Error(`permission mode did not restore to 'default'; got ${verifyMode.permission}`);
      }
      if (verifyMode.activeId !== SESSION_ID) {
        throw new Error(`activeId did not restore; got ${verifyMode.activeId}`);
      }

      const textarea = win2.locator('textarea').first();
      await textarea.waitFor({ state: 'visible', timeout: 15_000 });
      await textarea.click();
      await textarea.fill(
        `Please run the bash command \`echo ${MARKER}\` using the Bash tool. I want to verify the permission prompt works.`
      );
      await win2.keyboard.press('Enter');

      const dialog = win2.locator('[role="alertdialog"]').first();
      try {
        await dialog.waitFor({ state: 'visible', timeout: 30_000 });
      } catch {
        throw new Error('no [role="alertdialog"] permission prompt UI within 30s — PreToolUse hook (#94) regression?');
      }

      const headingHits = await dialog
        .locator('text=/Permission required|Allow this bash command\\?/')
        .first()
        .count();
      if (headingHits === 0) throw new Error('alertdialog visible but no recognisable permission heading');
      const dialogText = (await dialog.innerText()).toLowerCase();
      if (!dialogText.includes('bash') && !dialogText.includes(MARKER)) {
        throw new Error(`prompt does not mention Bash or the marker; saw: ${dialogText.slice(0, 400)}`);
      }

      const allowBtn = win2.locator('[data-perm-action="allow"]').first();
      await allowBtn.waitFor({ state: 'visible', timeout: 5_000 });
      await allowBtn.click();

      try {
        await dialog.waitFor({ state: 'detached', timeout: 10_000 });
      } catch {
        throw new Error('alertdialog still attached 10s after clicking Allow');
      }

      const markerSeen = await (async () => {
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const has = await win2.evaluate((m) => document.body.innerText.includes(m), MARKER);
          if (has) return true;
          await win2.waitForTimeout(500);
        }
        return false;
      })();
      if (!markerSeen) {
        throw new Error(`marker "${MARKER}" never appeared in conversation within 30s of Allow click`);
      }

      log(`permission prompt rendered, allow clicked, marker "${MARKER}" appeared in chat`);
    } finally {
      try { await app2.close(); closed = true; } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// CASE: default-cwd-model-from-recent-history
// Pre-launch fixture: plant 10 JSONL transcripts under a sandboxed HOME with
// controlled cwd/model frequency distributions. Boot the app, call
// `createSession()`, assert the new session's `cwd` and `model` come from the
// MOST-FREQUENT cwd/model in the last 10 CLI sessions — not the most recent.
//
// Task #293: dogfood found that default cwd/model on a fresh session were
// pulling from "most recently mtime'd" CLI session, which means a one-off
// `cd` into a side project hijacks the default. Fix: derive defaults from
// frequency over the last 10 sessions.
// ──────────────────────────────────────────────────────────────────────────
async function caseDefaultCwdModelFromRecentHistory({ log, registerDispose }) {
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-harness-default-cwd-home-'));
  registerDispose(() => { try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {} });
  const projectsRoot = path.join(fakeHome, '.claude', 'projects');
  fs.mkdirSync(projectsRoot, { recursive: true });

  // The frequency-ranked default sources from the last 10 jsonl files by mtime.
  // We design the 10 fixtures so:
  //   cwd  /path/A appears 6x, /path/B appears 4x  → expect default = /path/A
  //   model claude-opus-4-7[1m] appears 7x,
  //         claude-sonnet-4-6   appears 3x         → expect default = opus[1m]
  //
  // To prove this is FREQUENCY (not "most-recent mtime"), we make the SINGLE
  // most-recent fixture be the (B, sonnet) pair — pure-recency code would
  // pick those, frequency code picks (A, opus[1m]). That's the key bug
  // signal from dogfood.
  //
  // mtime layout (newest → oldest):
  //   t=10  → cwd /path/B, model sonnet  ← most recent (would win in old code)
  //   t=9   → cwd /path/B, model opus[1m]
  //   t=8   → cwd /path/A, model opus[1m]
  //   t=7   → cwd /path/A, model opus[1m]
  //   t=6   → cwd /path/B, model opus[1m]
  //   t=5   → cwd /path/A, model opus[1m]
  //   t=4   → cwd /path/A, model opus[1m]
  //   t=3   → cwd /path/A, model opus[1m]
  //   t=2   → cwd /path/B, model sonnet
  //   t=1   → cwd /path/A, model sonnet
  //   ─────────────────────────────────────
  //   /path/A: 6, /path/B: 4
  //   opus[1m]: 7, sonnet: 3
  const fixtures = [
    { mtime: 10, cwd: '/path/B', model: 'claude-sonnet-4-6' },
    { mtime: 9,  cwd: '/path/B', model: 'claude-opus-4-7[1m]' },
    { mtime: 8,  cwd: '/path/A', model: 'claude-opus-4-7[1m]' },
    { mtime: 7,  cwd: '/path/A', model: 'claude-opus-4-7[1m]' },
    { mtime: 6,  cwd: '/path/B', model: 'claude-opus-4-7[1m]' },
    { mtime: 5,  cwd: '/path/A', model: 'claude-opus-4-7[1m]' },
    { mtime: 4,  cwd: '/path/A', model: 'claude-opus-4-7[1m]' },
    { mtime: 3,  cwd: '/path/A', model: 'claude-opus-4-7[1m]' },
    { mtime: 2,  cwd: '/path/B', model: 'claude-sonnet-4-6' },
    { mtime: 1,  cwd: '/path/A', model: 'claude-sonnet-4-6' },
  ];

  // Plant each fixture as a separate jsonl, under the projectKey-from-cwd
  // directory the scanner reads from. Each session needs the cwd field on
  // the first user frame (so parseHead picks it up) and the model field on
  // an assistant frame.
  const baseTime = Date.now() - 10 * 60_000; // 10 min ago, drift-safe
  for (let i = 0; i < fixtures.length; i++) {
    const f = fixtures[i];
    const sid = `00000000-0000-4000-8000-00000000000${(i + 1).toString(16)}`;
    const projDir = path.join(projectsRoot, projectKeyFromCwd(f.cwd));
    fs.mkdirSync(projDir, { recursive: true });
    const filePath = path.join(projDir, `${sid}.jsonl`);
    const ts = new Date(baseTime + f.mtime * 1000).toISOString();
    const frames = [
      {
        type: 'user', parentUuid: null, isSidechain: false, uuid: `u-${i}`,
        cwd: f.cwd, sessionId: sid, timestamp: ts,
        message: { role: 'user', content: [{ type: 'text', text: `probe ${i}` }] }
      },
      {
        type: 'assistant', session_id: sid, parentUuid: `u-${i}`, isSidechain: false,
        uuid: `a-${i}`, cwd: f.cwd, timestamp: ts,
        message: {
          id: `msg-${i}`, role: 'assistant', model: f.model,
          content: [{ type: 'text', text: `reply ${i}` }]
        }
      }
    ];
    fs.writeFileSync(filePath, frames.map((fr) => JSON.stringify(fr)).join('\n') + '\n');
    // Force the file mtime to match the intended ordering — fs.writeFileSync
    // uses wallclock and a 10-fixture loop can complete inside one ms tick,
    // collapsing the ordering. Explicit utimes nails it down.
    const wantMs = baseTime + f.mtime * 1000;
    fs.utimesSync(filePath, wantMs / 1000, wantMs / 1000);
  }
  log(`planted 10 fixtures under ${projectsRoot} (cwd /path/A:6 /path/B:4; model opus[1m]:7 sonnet:3)`);

  const ud = isolatedUserData('ccsm-harness-default-cwd-userdata');
  registerDispose(ud.cleanup);

  const app = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`],
    cwd: ROOT,
    env: {
      ...process.env,
      NODE_ENV: 'production',
      CCSM_PROD_BUNDLE: '1',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
      CLAUDE_HOME: fakeHome
    }
  });
  let closed = false;
  registerDispose(async () => { if (!closed) try { await app.close(); } catch {} });

  try {
    const win = await waitReady(app);

    // Wait for the boot-time history scan IPC to populate the renderer
    // store. The store seeds `historyRecentCwds` + `historyTopModel` from
    // `window.ccsm.recentCwds()` + `topModel()` — both are async and not
    // awaited by hydration, so we poll until the values land.
    await win.waitForFunction(
      () => {
        const s = window.__ccsmStore?.getState?.();
        return !!s && Array.isArray(s.historyRecentCwds) && s.historyRecentCwds.length > 0 && typeof s.historyTopModel === 'string';
      },
      null,
      { timeout: 15_000 }
    );

    // Snapshot what the renderer thinks the history defaults are, before
    // we exercise createSession. If THIS is wrong, the createSession
    // assertion below will fail too, but the snapshot lets us pinpoint
    // whether the regression is in the IPC scan or in the store fallback.
    const seeded = await win.evaluate(() => {
      const s = window.__ccsmStore.getState();
      return {
        historyRecentCwds: s.historyRecentCwds,
        historyTopModel: s.historyTopModel,
        // Also snapshot the in-memory store's `model` and `recentProjects`
        // — both should be empty on this fresh user-data dir, which is
        // what makes the history-derived defaults the actual source.
        globalModel: s.model,
        recentProjectsCount: (s.recentProjects ?? []).length,
      };
    });
    log(`seeded defaults: historyRecentCwds[0]=${seeded.historyRecentCwds[0]} historyTopModel=${seeded.historyTopModel} (globalModel="${seeded.globalModel}", recentProjects=${seeded.recentProjectsCount})`);

    if (seeded.historyRecentCwds[0] !== '/path/A') {
      throw new Error(`task#293: historyRecentCwds[0] should be the FREQUENCY-TOP cwd (/path/A appears 6x); got ${JSON.stringify(seeded.historyRecentCwds)}`);
    }
    if (seeded.historyTopModel !== 'claude-opus-4-7[1m]') {
      throw new Error(`task#293: historyTopModel should be the FREQUENCY-TOP model (claude-opus-4-7[1m] appears 7x); got ${seeded.historyTopModel}`);
    }

    // Now drive createSession() and verify the new session inherits the
    // frequency-top cwd + model. We zero out `sessions` first so the
    // task328 group-recent-cwd path doesn't shadow the history default
    // (no sessions in any group → falls through to historyRecentCwds[0]).
    const created = await win.evaluate(() => {
      const st = window.__ccsmStore;
      st.setState({
        sessions: [],
        groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
        activeId: '',
        focusedGroupId: 'g-default',
        // Defensive: belt-and-suspenders zero-out for a possibly-persisted
        // global model from a prior install. With the user-data dir freshly
        // created this is already '', but stating it makes the assertion
        // about "frequency-default wins" unambiguous.
        model: '',
        recentProjects: [],
      });
      st.getState().createSession();
      const s = st.getState();
      const newSession = s.sessions[0];
      return { cwd: newSession?.cwd, model: newSession?.model };
    });
    log(`createSession() produced cwd=${created.cwd} model=${created.model}`);

    if (created.cwd !== '/path/A') {
      throw new Error(`task#293: new session cwd should be /path/A (most-frequent in last 10 sessions); got ${created.cwd}`);
    }
    if (created.model !== 'claude-opus-4-7[1m]') {
      throw new Error(`task#293: new session model should be claude-opus-4-7[1m] (most-frequent in last 10 sessions); got ${created.model}`);
    }
    log(`task#293 PASS — default cwd/model derive from last-10 frequency`);
  } finally {
    closed = true;
    try { await app.close(); } catch {}
  }
}


await runHarness({
  name: 'restore',
  // Every case is skipLaunch — they all manage their own electron lifecycle
  // because the harness-runner capability set doesn't (yet) expose the
  // user-data dir to the case body, which the multi-launch / pre-launch
  // fixture pattern requires.
  cases: [
    { id: 'restore',                  skipLaunch: true, run: caseRestore },
    { id: 'restore-journey-plan',     skipLaunch: true, run: caseRestoreJourneyPlan },
    { id: 'restore-journey-question', skipLaunch: true, run: caseRestoreJourneyQuestion },
    { id: 'sidebar-resize',           skipLaunch: true, run: caseSidebarResize },
    { id: 'sidebar-rename-dnd-state', skipLaunch: true, run: caseSidebarRenameDndState },
    { id: 'db-corruption-recovery',   skipLaunch: true, run: caseDbCorruptionRecovery },
    { id: 'notify-fallback',          skipLaunch: true, run: caseNotifyFallback },
    { id: 'import-session',           skipLaunch: true, run: caseImportSession },
    // ---- Bucket-7 absorption (final cleanup pass) ----
    // permission-prompt-default-mode: 2-launch (seed → close → relaunch)
    // with sandboxed CLAUDE_CONFIG_DIR + real claude.exe Bash invocation.
    // 桶 3 worker classified as restore-fits-the-multi-launch pattern.
    { id: 'permission-prompt-default-mode', skipLaunch: true, requiresClaudeBin: true, run: casePermissionPromptDefaultMode },
    // task#293: default cwd/model on a fresh session derive from frequency
    // over the last 10 CLI sessions. Pre-launch HOME sandbox + 10 jsonl
    // fixtures with controlled cwd/model distribution.
    { id: 'default-cwd-model-from-recent-history', skipLaunch: true, run: caseDefaultCwdModelFromRecentHistory }
  ]
});
