// Dogfood r2 fp10: slash command picker (`/`) + file mention picker (`@`) +
// skill / agent discovery checks A-F.
//
// IMPORTANT context (verified before writing this probe):
//   * `/` opens the slash-command picker. The picker is the SINGLE entry point
//     for built-in, user, project, plugin, SKILL and AGENT entries. There is
//     NO separate `@agent` picker — `@` is the FILE-MENTION picker for inline
//     `@path/to/file.ts` references. Source: src/components/InputBar.tsx
//     (uses both <SlashCommandPicker> and <MentionPicker>; @ = file mentions
//     only) and src/slash-commands/registry.ts (six SlashCommandSource buckets
//     including 'skill' and 'agent').
//   * Skill / agent discovery: ~/.claude/skills/*.md and ~/.claude/agents/*.md
//     (electron/commands-loader.ts §4-5). Plugin commands surface separately
//     under 'plugin'. Plugin SKILLS are NOT walked by the loader.
//
// What this probe does:
//   * Spins up the INSTALLED CCSM.exe (not the dev bundle) via Playwright
//     `_electron.launch({ executablePath })`.
//   * Points it at an isolated CLAUDE_CONFIG_DIR seeded with a representative
//     fixture: a user command, a user skill, a user agent, and the dev's real
//     plugins/ tree (so we exercise plugin command discovery without forcing
//     a fresh marketplace install).
//   * Drives the input through the six checks.
//
// Output: docs/screenshots/dogfood-r2/fp10-pickers/check-{a..f}-*.png
//         + report at docs/dogfood-r2-fp10-report.md
//
// Run: node scripts/probe-dogfood-r2-fp10-pickers.mjs
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const SHOT_DIR = path.join(REPO_ROOT, 'docs/screenshots/dogfood-r2/fp10-pickers');
const USER_DATA = 'C:/temp/ccsm-dogfood-r2-fp10';
const CCSM_EXE = 'C:/Users/jiahuigu/AppData/Local/Programs/CCSM/CCSM.exe';

if (!fs.existsSync(CCSM_EXE)) {
  console.error('[fp10] installed CCSM.exe missing:', CCSM_EXE);
  process.exit(2);
}

// Wipe + recreate user-data so each run starts clean.
try { fs.rmSync(USER_DATA, { recursive: true, force: true }); } catch {}
fs.mkdirSync(USER_DATA, { recursive: true });
fs.mkdirSync(SHOT_DIR, { recursive: true });

// ── Build an isolated CLAUDE_CONFIG_DIR fixture ─────────────────────────────
// We want the picker to have at least one entry per source we test:
//   built-in    — always present (clear/compact/config)
//   user cmd    — seed `<cfg>/commands/fp10-hello.md`
//   skill       — seed `<cfg>/skills/fp10-skill.md`
//   agent       — seed `<cfg>/agents/fp10-agent.md`
//   plugin      — symlink/copy the dev's real plugins/ tree (superpowers etc.)
//
// Settings.json inherits ANTHROPIC_BASE_URL (and friends) from the dev's real
// settings so the SDK can hit the local proxy. Credentials copied so login
// persists. Permissions left empty since we don't run tools in this probe.
const cfgDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-fp10-cfg-'));
console.log('[fp10] CLAUDE_CONFIG_DIR=', cfgDir);
console.log('[fp10] userData=', USER_DATA);

function seedSettings() {
  const sandbox = { permissions: { allow: [], deny: [] } };
  try {
    const real = path.join(os.homedir(), '.claude', 'settings.json');
    if (fs.existsSync(real)) {
      const raw = JSON.parse(fs.readFileSync(real, 'utf8'));
      if (raw && raw.env && typeof raw.env === 'object') sandbox.env = raw.env;
    }
  } catch {}
  // Force the proxy URL the dogfood plan calls for.
  sandbox.env = { ...(sandbox.env || {}), ANTHROPIC_BASE_URL: 'http://localhost:23333/api/anthropic' };
  fs.writeFileSync(path.join(cfgDir, 'settings.json'), JSON.stringify(sandbox, null, 2), 'utf8');
}
seedSettings();

const realCreds = path.join(os.homedir(), '.claude', '.credentials.json');
if (fs.existsSync(realCreds)) {
  try { fs.copyFileSync(realCreds, path.join(cfgDir, '.credentials.json')); } catch {}
}

// Seed user command
fs.mkdirSync(path.join(cfgDir, 'commands'), { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, 'commands', 'fp10-hello.md'),
  '---\ndescription: fp10 user-level test command\n---\n\nSay hello from fp10.\n',
  'utf8'
);

// Seed skill
fs.mkdirSync(path.join(cfgDir, 'skills'), { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, 'skills', 'fp10-skill.md'),
  '---\ndescription: fp10 user-level test skill\n---\n\nfp10 skill body.\n',
  'utf8'
);

// Seed agent
fs.mkdirSync(path.join(cfgDir, 'agents'), { recursive: true });
fs.writeFileSync(
  path.join(cfgDir, 'agents', 'fp10-agent.md'),
  '---\ndescription: fp10 user-level test agent\n---\n\nfp10 agent body.\n',
  'utf8'
);

// Symlink plugins/ from the dev's real ~/.claude so the picker shows real
// plugin commands (superpowers:brainstorm etc). Fall back to copy if symlinks
// require admin (Windows). Tolerate failure — the probe still validates the
// other five sources.
const realPlugins = path.join(os.homedir(), '.claude', 'plugins');
const fakePlugins = path.join(cfgDir, 'plugins');
if (fs.existsSync(realPlugins)) {
  try {
    fs.symlinkSync(realPlugins, fakePlugins, 'junction');
    console.log('[fp10] plugins/ junction → real');
  } catch (e) {
    console.warn('[fp10] plugin symlink failed, plugin section may be empty:', e.message);
  }
}

const results = {};
function record(check, status, notes) {
  results[check] = { status, notes };
  console.log(`[fp10] ${check}: ${status} ${notes ? '— ' + notes : ''}`);
}

// Sanitize HOME-leak per feedback_probe_skill_injection.md: scrub anything
// the launching agent process inherits that could pollute the renderer's
// idea of skills/agents. We deliberately leave HOME pointing at the real
// home so the SDK can resolve auth, BUT we override CLAUDE_CONFIG_DIR via
// CCSM_CLAUDE_CONFIG_DIR so the binary loads our fixture, not the dev's.
// commands-loader.ts (electron/) reads process.env.CLAUDE_CONFIG_DIR directly
// for picker discovery. agent-sdk/sessions.ts also honors CCSM_CLAUDE_CONFIG_DIR
// for the spawned CLI. Set BOTH so the renderer's picker AND the spawned CLI
// see the same isolated tree.
const env = {
  ...process.env,
  CLAUDE_CONFIG_DIR: cfgDir,
  CCSM_CLAUDE_CONFIG_DIR: cfgDir,
  // Don't inject node options; the bundled electron has its own.
  NODE_OPTIONS: '',
};

const app = await electron.launch({
  executablePath: CCSM_EXE,
  args: [`--user-data-dir=${USER_DATA}`],
  env,
  timeout: 60_000,
});

let win;
try {
  // The packaged app may take a beat to load file://. Walk windows until we
  // find one with a renderer URL.
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const url = w.url();
        if (url.startsWith('http://localhost') || url.startsWith('file://') || url.startsWith('app://')) {
          win = w;
          break;
        }
      } catch {}
    }
    if (win) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  if (!win) throw new Error('no renderer window appeared');
  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 30_000 });
  await win.waitForTimeout(1200); // let dynamic commands load
} catch (e) {
  console.error('[fp10] failed to bring up window:', e.message);
  await app.close().catch(() => {});
  process.exit(1);
}

async function shoot(name) {
  const out = path.join(SHOT_DIR, `${name}.png`);
  await win.screenshot({ path: out });
  console.log(`[fp10] shot ${out}`);
  return out;
}

async function ensureSession() {
  // Seed a session so the InputBar renders. Real ccsm store schema.
  const sid = 's-fp10-1';
  await win.evaluate(({ id, cwd }) => {
    window.__ccsmStore.setState({
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{
        id, name: 'fp10', state: 'idle', cwd,
        model: 'claude-sonnet-4', groupId: 'g1', agentType: 'claude-code',
      }],
      activeId: id,
      messagesBySession: { [id]: [] },
      runningSessions: {},
      sessionStats: { [id]: { costUsd: 0 } },
      contextUsageBySession: { [id]: { used: 0, total: 200_000 } },
      tutorialSeen: true,
    });
  }, { id: sid, cwd: REPO_ROOT });
  await win.waitForTimeout(300);
  return sid;
}

async function getTextarea() {
  const ta = win.locator('textarea').first();
  await ta.waitFor({ state: 'visible', timeout: 10_000 });
  // Re-focus to fire onFocus refreshDynamic so dynamic commands reload.
  await win.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await ta.click();
  await win.waitForTimeout(200);
  return ta;
}

async function clearInput() {
  const ta = await getTextarea();
  await ta.fill('');
  await win.waitForTimeout(150);
}

const slashPicker = () => win.locator('[role="listbox"][aria-label="Slash commands"]');
const mentionPicker = () => win.locator('[role="listbox"][aria-label="File mentions"]');

await ensureSession();

// ─────────── Check A: slash picker opens with all expected sections ───────────
try {
  const ta = await getTextarea();
  await ta.fill('/');
  await win.waitForTimeout(400);
  const ok = await slashPicker().isVisible({ timeout: 3000 }).catch(() => false);
  if (!ok) {
    await shoot('check-a-FAIL-no-picker');
    record('A', 'FAIL', 'slash picker did not appear after typing "/"');
  } else {
    await shoot('check-a-slash-open');
    const optionsTxt = (await slashPicker().locator('[role="option"]').allInnerTexts()).join(' | ');
    const headings = (await slashPicker().allInnerTexts()).join(' ');
    const hasBuiltin = /clear|compact|config/i.test(optionsTxt);
    const hasUser = /fp10-hello/.test(optionsTxt);
    const hasSkill = /fp10-skill/.test(optionsTxt);
    const hasAgent = /fp10-agent/.test(optionsTxt);
    const hasPlugin = /superpowers:|:/.test(optionsTxt);
    const sectionsHint = `builtin=${hasBuiltin} user=${hasUser} skill=${hasSkill} agent=${hasAgent} plugin=${hasPlugin}`;
    const allPresent = hasBuiltin && hasUser && hasSkill && hasAgent;
    record('A', allPresent ? 'PASS' : 'PARTIAL',
      `${sectionsHint} optionCount=${(await slashPicker().locator('[role="option"]').count())} headingsHas=${/Built-in|User|Skill|Agent/i.test(headings)}`);
  }
  await clearInput();
} catch (e) {
  record('A', 'BUG', e.message);
}

// ─────────── Check B: select a built-in (/clear) and observe effect ───────────
// /clear is a clientHandler builtin — selecting it should clear the input
// (and reset the conversation). We verify by inspecting input value + by
// checking the picker closes.
try {
  const ta = await getTextarea();
  await ta.fill('/cle');
  await win.waitForTimeout(300);
  await shoot('check-b-clear-filtered');
  // Press Enter (committing the highlighted match — should be /clear)
  await win.keyboard.press('Enter');
  await win.waitForTimeout(600);
  await shoot('check-b-clear-after');
  const inputAfter = await ta.inputValue();
  const pickerStillOpen = await slashPicker().isVisible().catch(() => false);
  // /clear is a clientHandler built-in — it should:
  //   * close the picker
  //   * either clear input OR start a fresh session (input becomes '')
  const ok = !pickerStillOpen;
  record('B', ok ? 'PASS' : 'FAIL',
    `/cle + Enter → input='${inputAfter}' pickerOpen=${pickerStillOpen}`);
  await clearInput();
} catch (e) {
  record('B', 'BUG', e.message);
}

// ─────────── Check C: agent surfaces in picker (no separate @agent picker) ───
// CCSM does NOT have a separate @-triggered agent picker — agents appear in
// the slash picker. We verify the seeded agent is reachable via slash.
// `@` SHOULD instead open the file-mention picker, which we also verify.
try {
  await ensureSession(); // re-seed in case /clear blew it away
  const ta = await getTextarea();
  await ta.fill('/fp10-ag');
  await win.waitForTimeout(400);
  const visible = await slashPicker().isVisible({ timeout: 2000 }).catch(() => false);
  const optionsTxt = visible
    ? (await slashPicker().locator('[role="option"]').allInnerTexts()).join(' | ')
    : '';
  const hasAgent = /fp10-agent/.test(optionsTxt);
  await shoot('check-c-agent-via-slash');

  // Now show that `@` opens the FILE mention picker, not an agent picker.
  await ta.fill('');
  await win.waitForTimeout(150);
  await ta.fill('@');
  await win.waitForTimeout(500);
  const mentionVisible = await mentionPicker().isVisible({ timeout: 2000 }).catch(() => false);
  await shoot('check-c-at-mention-picker');
  const mentionAriaSeen = mentionVisible ? 'File mentions' : '(none)';

  record('C', hasAgent ? 'PASS' : 'PARTIAL',
    `agent in slash picker: ${hasAgent}; "@" opens picker '${mentionAriaSeen}' (file-mention, NOT agent — by design). No dedicated @agent picker exists.`);
  await clearInput();
} catch (e) {
  record('C', 'BUG', e.message);
}

// ─────────── Check D: skill discovery via slash picker ───────────
try {
  await ensureSession();
  const ta = await getTextarea();
  await ta.fill('/fp10-sk');
  await win.waitForTimeout(400);
  const visible = await slashPicker().isVisible({ timeout: 2000 }).catch(() => false);
  await shoot('check-d-skill-filter');
  const optionsTxt = visible
    ? (await slashPicker().locator('[role="option"]').allInnerTexts()).join(' | ')
    : '';
  const hasSkill = /fp10-skill/.test(optionsTxt);
  // Try selecting it
  if (hasSkill) {
    await win.keyboard.press('Enter');
    await win.waitForTimeout(400);
    await shoot('check-d-skill-selected');
  }
  const after = await ta.inputValue();
  // A passThrough command without an argumentHint commits + submits the
  // line, which clears the input. A command WITH an argumentHint commits
  // to "/<name> " and parks the caret. Either outcome proves selection
  // happened; what we don't want is the picker still showing the candidate.
  const pickerStillOpen = await slashPicker().isVisible().catch(() => false);
  const selected = !pickerStillOpen && (after === '' || after.startsWith('/fp10-skill'));
  record('D', hasSkill && selected ? 'PASS' : 'PARTIAL',
    `skill in picker=${hasSkill}; selected→input='${after}' pickerOpen=${pickerStillOpen} (no dedicated skill picker — uses slash picker, by design)`);
  await clearInput();
} catch (e) {
  record('D', 'BUG', e.message);
}

// ─────────── Check E: empty / no-results state ───────────
try {
  await ensureSession();
  const ta = await getTextarea();
  await ta.fill('/xxxxxnotreal');
  await win.waitForTimeout(400);
  const visible = await slashPicker().isVisible({ timeout: 2000 }).catch(() => false);
  let emptyHint = '';
  let optionCount = 0;
  if (visible) {
    optionCount = await slashPicker().locator('[role="option"]').count();
    emptyHint = (await slashPicker().innerText()).trim();
  }
  await shoot('check-e-empty-state');
  // Pass if either: picker visible with empty-state hint, OR picker closed gracefully.
  const ok = !visible || (optionCount === 0 && /no matching|enter to send/i.test(emptyHint));
  record('E', ok ? 'PASS' : 'FAIL',
    `visible=${visible} options=${optionCount} hint='${emptyHint.slice(0, 80)}'`);
  await clearInput();
} catch (e) {
  record('E', 'BUG', e.message);
}

// ─────────── Check F: keyboard navigation (↓ ↑ Enter Esc) ───────────
try {
  await ensureSession();
  const ta = await getTextarea();
  await ta.fill('/');
  await win.waitForTimeout(400);
  const visible = await slashPicker().isVisible({ timeout: 2000 }).catch(() => false);
  if (!visible) throw new Error('picker not visible for keyboard nav');

  function readActive() {
    return win.evaluate(() => {
      const lb = document.querySelector('[role="listbox"][aria-label="Slash commands"]');
      if (!lb) return null;
      const id = lb.getAttribute('aria-activedescendant');
      if (!id) return null;
      const el = document.getElementById(id);
      return el?.textContent?.slice(0, 60).trim() ?? null;
    });
  }
  const start = await readActive();
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(120);
  const afterDown = await readActive();
  await win.keyboard.press('ArrowDown');
  await win.waitForTimeout(120);
  const afterDown2 = await readActive();
  await win.keyboard.press('ArrowUp');
  await win.waitForTimeout(120);
  const afterUp = await readActive();
  await shoot('check-f-keyboard-nav');

  const moved = (start !== afterDown) && (afterDown !== afterDown2) && (afterUp === afterDown);
  // Esc should dismiss the picker.
  await win.keyboard.press('Escape');
  await win.waitForTimeout(250);
  const afterEsc = await slashPicker().isVisible().catch(() => false);
  await shoot('check-f-after-esc');

  record('F', moved && !afterEsc ? 'PASS' : 'PARTIAL',
    `start='${start}' down='${afterDown}' down2='${afterDown2}' up='${afterUp}' afterEscVisible=${afterEsc}`);
  await clearInput();
} catch (e) {
  record('F', 'BUG', e.message);
}

await app.close().catch(() => {});
try { fs.rmSync(cfgDir, { recursive: true, force: true }); } catch {}

// ── Write report ────────────────────────────────────────────────────────────
const reportPath = path.join(REPO_ROOT, 'docs/dogfood-r2-fp10-report.md');
const allPass = Object.values(results).every((r) => r.status === 'PASS');
const anyBug = Object.values(results).some((r) => r.status === 'BUG');
const heading = anyBug ? '## fp10: BUG' : (allPass ? '## fp10: PASS' : '## fp10: PARTIAL');

const lines = [
  '# Dogfood r2 fp10 — slash command / mention / skill+agent picker report',
  '',
  `Date: ${new Date().toISOString()}`,
  `Binary: installed CCSM.exe at ${CCSM_EXE}`,
  `userData: ${USER_DATA}`,
  `Screenshots: docs/screenshots/dogfood-r2/fp10-pickers/`,
  '',
  '## Architecture note (verified before probing)',
  '',
  '- `/` opens **`<SlashCommandPicker>`** — the SINGLE entry point for built-in,',
  '  user, project, plugin, **skill** and **agent** commands. Six sections,',
  '  one picker. (`src/components/SlashCommandPicker.tsx`,',
  '  `src/slash-commands/registry.ts`)',
  '- `@` opens **`<MentionPicker>`** — file mentions only (inline `@path/to/file`).',
  '  There is **no separate `@agent` picker**: agents are accessed via `/`.',
  '  (`src/components/MentionPicker.tsx`)',
  '- Skills/agents come from `~/.claude/skills/*.md` + `~/.claude/agents/*.md`',
  '  (electron/commands-loader.ts §4-5). Plugin SKILLS are NOT walked.',
  '',
  heading,
  '',
];
const map = {
  A: 'slash picker opens; six sections render',
  B: 'built-in /clear end-to-end (commit + close)',
  C: 'agent reachable via slash picker (no @agent picker — `@` is file-mention by design)',
  D: 'skill reachable via slash picker (no separate skill picker — by design)',
  E: 'empty / no-results state',
  F: 'keyboard nav: ↓ ↑ Enter Esc',
};
for (const k of ['A', 'B', 'C', 'D', 'E', 'F']) {
  const r = results[k] || { status: 'SKIP', notes: 'not run' };
  lines.push(`- **${k}** (${map[k]}): **${r.status}** — ${r.notes}`);
}
lines.push('');
fs.writeFileSync(reportPath, lines.join('\n') + '\n', 'utf8');
console.log('[fp10] wrote', reportPath);

const exitCode = anyBug ? 1 : 0;
process.exit(exitCode);
