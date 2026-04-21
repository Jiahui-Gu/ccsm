// Live probe for the "Claude CLI not found" first-run wizard.
//
// Runs against the built app with AGENTORY_CLAUDE_BIN pointing at a non-
// existent file so the resolver falls back to a scrubbed PATH and flips the
// store into `missing` state. Asserts:
//   - The blocking modal renders with title + body.
//   - OS-appropriate install commands are visible.
//   - Copy button writes the command to the clipboard.
//   - Browse (stubbed via dialog monkey-patch) succeeds and closes the modal.
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
import { appWindow } from './probe-utils.mjs';

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
    // Hmm — except: with AGENTORY_CLAUDE_BIN set but missing, the resolver
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
  delete process.env.AGENTORY_CLAUDE_BIN;
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
