// Live probe for the "Claude CLI not found" first-run wizard.
//
// Case A (original): Runs against the built app with CCSM_CLAUDE_BIN
// pointing at a non-existent file so the resolver falls back to a scrubbed
// PATH and flips the store into `missing` state. Asserts:
//   - The blocking modal renders with title + body.
//   - OS-appropriate install commands are visible.
//   - Copy button writes the command to the clipboard.
//   - Browse (stubbed via dialog monkey-patch) succeeds and closes the modal.
//
// Case B (stale persisted binPath, P0 regression — see fix/stale-binpath-p0):
//   - Pre-seeds the SQLite `app_state` table with `claudeBinPath` pointing
//     at a path that does not exist on disk (mimics a dev probe whose temp
//     dir was GC'd).
//   - Calls `agent:start` directly with empty PATH.
//   - Asserts `errorCode === 'CLAUDE_NOT_FOUND'` (NOT a generic spawn
//     error) and that the stale row was self-healed (DB row cleared).
//   - Reverse-verify: stash the validation block in electron/main.ts → this
//     case must FAIL because spawn dies via cmd.exe with "system cannot
//     find the path specified" and CLAUDE_NOT_FOUND is never raised.
//
// Env vars understood:
//   AGENTORY_FAKE_CLAUDE   path to a fake binary whose `--version` outputs
//                          "2.1.9"; optional — if unset, we create one in
//                          a temp dir and clean up at the end.
//
// Run: `node scripts/probe-cli-missing.mjs` (requires `npm run build` first).
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-cli-missing] FAIL: ${msg}`);
  process.exit(1);
}

// 1) Build a fake claude "binary" that replies to --version. On Windows we
//    use a .cmd script (the CLI wizard's setBinaryPath runs `--version`
//    through shell:true on Windows); on POSIX we use a chmod +x shell script.
function writeFakeBinary(dir) {
  if (process.platform === 'win32') {
    const p = path.join(dir, 'fake-claude.cmd');
    fs.writeFileSync(p, '@echo off\r\necho 2.1.9 (fake)\r\nexit /b 0\r\n');
    return p;
  }
  const p = path.join(dir, 'fake-claude.sh');
  fs.writeFileSync(p, `#!/bin/sh\nprintf '2.1.9 (fake)\\n'\nexit 0\n`);
  fs.chmodSync(p, 0o755);
  return p;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-cli-missing-'));
const fakeBin = process.env.AGENTORY_FAKE_CLAUDE ?? writeFakeBinary(tmp);

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    // Point the resolver at a file that doesn't exist — this triggers the
    // "throws with non-existent override" branch in resolveClaudeBinary and
    // surfaces to the renderer as CLAUDE_NOT_FOUND after we click "Send".
    //
    // Hmm — except: with CCSM_CLAUDE_BIN set but missing, the resolver
    // throws a plain Error (not ClaudeNotFoundError), which falls through to
    // generic error. For this probe we want the missing flow — so clear the
    // env var and rely on PATH being empty below.
  },
});

// Monkey-patch the resolver's PATH lookup by clearing PATH inside the main
// process before the renderer mounts. The store's checkCli() on mount will
// then call cli:retryDetect → resolveClaudeBinary throws ClaudeNotFoundError
// → store flips to 'missing' → dialog opens.
await app.evaluate(async () => {
  process.env.PATH = '';
  process.env.path = '';
  if (process.platform === 'win32') process.env.PATHEXT = '';
  delete process.env.CCSM_CLAUDE_BIN;
});

// Stub the file picker to return our fake binary when the user clicks
// "Browse for binary…".
await app.evaluate(async ({ dialog }, picked) => {
  dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [picked] });
}, fakeBin);

const win = await appWindow(app);
const errors = [];
win.on('pageerror', (e) => errors.push(`[pageerror] ${e.message}`));
win.on('console', (m) => {
  if (m.type() === 'error') errors.push(`[console.error] ${m.text()}`);
});

await win.waitForLoadState('domcontentloaded');

// 2) Wait for the dialog — the store runs checkCli() on App mount.
const title = win.getByText('Claude CLI not found').first();
await title.waitFor({ state: 'visible', timeout: 10_000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body text at failure ---\n' + dump);
  console.error('--- errors ---\n' + errors.slice(-10).join('\n'));
  await app.close();
  fail('modal did not appear — checkCli() never flipped to missing');
});

// 3) Assert install commands render for this OS. At minimum, the npm command
//    is present on every platform.
const npmCmd = win.getByTestId('cli-cmd-npm').first();
await npmCmd.waitFor({ state: 'visible', timeout: 3000 });
const npmText = (await npmCmd.textContent()) ?? '';
if (!/npm install -g @anthropic-ai\/claude-code/.test(npmText)) {
  await app.close();
  fail(`npm command missing expected text, got: ${JSON.stringify(npmText)}`);
}

// 4) Copy button: click and verify clipboard contents via the renderer.
const copyBtn = win.getByRole('button', { name: /copy npm command/i }).first();
await copyBtn.click();
await win.waitForTimeout(150);
const clip = await win.evaluate(async () => await navigator.clipboard.readText().catch(() => ''));
if (!/npm install -g @anthropic-ai\/claude-code/.test(clip)) {
  await app.close();
  fail(`clipboard did not contain npm command, got: ${JSON.stringify(clip)}`);
}

// 5) Switch to "I already have it" tab and Browse.
await win.getByRole('tab', { name: /i already have it/i }).click();
const browseBtn = win.getByRole('button', { name: /browse for binary/i }).first();
await browseBtn.waitFor({ state: 'visible', timeout: 3000 });
await browseBtn.click();

// 6) Success pane should appear with detected version.
const detected = win.getByText('Claude CLI detected').first();
await detected.waitFor({ state: 'visible', timeout: 5000 }).catch(async () => {
  const dump = await win.evaluate(() => document.body.innerText.slice(0, 1500));
  console.error('--- body text ---\n' + dump);
  await app.close();
  fail('success pane did not appear after Browse');
});

const versionText = (await win.getByText(/2\.1\.9/).first().textContent().catch(() => '')) ?? '';
if (!/2\.1\.9/.test(versionText)) {
  await app.close();
  fail('detected version not rendered in success pane');
}

console.log('\n[probe-cli-missing] OK');
console.log('  dialog:     shown');
console.log('  npm cmd:    rendered + clipboard roundtrip ok');
console.log('  browse:     picked fake binary, version 2.1.9 detected');

await app.close();
try {
  fs.rmSync(tmp, { recursive: true, force: true });
} catch {
  /* ignore */
}

// ─────────────────────────────────────────────────────────────────────────────
// Case B: stale persisted claudeBinPath self-heals on agent:start.
// ─────────────────────────────────────────────────────────────────────────────
// Regression guard for the P0 first-message-fails-on-prod-install bug.
// Pre-condition: SQLite has `claudeBinPath = <non-existent path>`. Without
// the fix, agent:start would forward this to spawnClaude(), which routes a
// `.cmd` extension through cmd.exe and exits with a generic "system cannot
// find the path specified" — CLAUDE_NOT_FOUND is never raised, so the
// CliMissingDialog never shows and the user is stuck. The fix validates the
// persisted path before forwarding and clears the dead row.
{
  const ud = isolatedUserData('probe-cli-missing-stalebinpath');

  // Pre-seed parameters: a path that points at a definitely-non-existent
  // file. Using a Windows-style fake .cmd path mirrors the real-world repro
  // (a leftover entry from a probe like Case A above).
  const stalePath =
    process.platform === 'win32'
      ? path.join(ud.dir, 'gone', 'fake-claude.cmd')
      : path.join(ud.dir, 'gone', 'fake-claude.sh');

  // Sanitize HOME / USERPROFILE so the developer's ~/.claude skills do not
  // leak into the spawned CLI's environment (per
  // memory/project_probe_skill_injection.md — relevant for any probe that
  // launches electron and may end up spawning the real CLI).
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-binpath-home-'));

  const app2 = await electron.launch({
    args: ['.', `--user-data-dir=${ud.dir}`],
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: 'development',
      HOME: fakeHome,
      USERPROFILE: fakeHome,
    },
  });

  // Empty PATH so resolveClaudeBinary throws ClaudeNotFoundError after the
  // self-heal fires. Otherwise a real claude on PATH could mask the bug by
  // succeeding through the resolver fall-through.
  await app2.evaluate(async () => {
    process.env.PATH = '';
    process.env.path = '';
    if (process.platform === 'win32') process.env.PATHEXT = '';
    delete process.env.CCSM_CLAUDE_BIN;
  });

  const win2 = await appWindow(app2);
  await win2.waitForLoadState('domcontentloaded');
  await win2.waitForFunction(() => !!window.ccsm?.agentStart, null, {
    timeout: 10_000,
  });

  // Seed claudeBinPath via the same IPC the renderer uses for state writes.
  // This mirrors how the production app would have ended up with a stale
  // value (the first-run wizard's saveClaudeBinPath path under the hood
  // routes through the same app_state row).
  await win2.evaluate(async (p) => {
    await window.ccsm.saveState('claudeBinPath', p);
  }, stalePath);

  // Sanity: the seed actually landed.
  const seeded = await win2.evaluate(async () => {
    return await window.ccsm.loadState('claudeBinPath');
  });
  if (seeded !== stalePath) {
    await app2.close();
    ud.cleanup();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    fail(`pre-seed failed: claudeBinPath read back as ${JSON.stringify(seeded)}`);
  }

  // Drive agent:start directly so we observe its return shape — this is
  // exactly the path InputBar takes on first message send. We pass `cwd:
  // root` (this repo) so the CWD existsSync guard is satisfied; the only
  // thing under test is binaryPath validation + CLAUDE_NOT_FOUND surfacing.
  const startResult = await win2.evaluate(async (cwd) => {
    return await window.ccsm.agentStart('probe-stale-binpath-session', { cwd });
  }, root);

  if (startResult.ok) {
    await app2.close();
    ud.cleanup();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    fail(
      'agent:start unexpectedly succeeded with stale binPath + empty PATH; ' +
        'expected ok:false errorCode:CLAUDE_NOT_FOUND'
    );
  }
  if (startResult.errorCode !== 'CLAUDE_NOT_FOUND') {
    await app2.close();
    ud.cleanup();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    fail(
      `agent:start returned the wrong errorCode for stale binPath. ` +
        `Expected CLAUDE_NOT_FOUND, got ${JSON.stringify(startResult)}. ` +
        `This is the P0 regression: stale binPath bypasses resolveClaudeBinary().`
    );
  }

  // Self-heal assertion: the stale row must have been cleared from the DB so
  // a subsequent launch falls cleanly into the resolver / first-run wizard
  // instead of hitting the same dead path forever.
  const after = await win2.evaluate(async () => {
    return await window.ccsm.loadState('claudeBinPath');
  });
  if (after !== null) {
    await app2.close();
    ud.cleanup();
    try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    fail(
      `stale claudeBinPath was NOT self-healed after agent:start. ` +
        `Read back: ${JSON.stringify(after)}`
    );
  }

  await app2.close();
  ud.cleanup();
  try { fs.rmSync(fakeHome, { recursive: true, force: true }); } catch {}

  console.log('\n[probe-cli-missing] OK (case B: stale binPath)');
  console.log('  agent:start: returned errorCode CLAUDE_NOT_FOUND as expected');
  console.log('  self-heal:   stale claudeBinPath row cleared from DB');
}
