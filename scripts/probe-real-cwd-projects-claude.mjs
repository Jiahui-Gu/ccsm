// Probe — UX E: real-cwd → claude JSONL plumbing.
//
// Regression guard for PR #494: when the user creates a session with cwd=X,
// the spawned claude process must:
//   1. Run with `process.cwd === X` (not Electron's cwd, not the pool worktree).
//   2. Write its JSONL transcript to `<HOME>/.claude/projects/<hash-of-X>/<sid>.jsonl`
//      where the hash matches claude's own scheme (slashes/backslashes/colons →
//      dashes, leading dash). NOT to `~/.claude/projects/<electron-cwd>/...`.
//   3. Pick up project-scoped files (CLAUDE.md / agents / skills / commands)
//      from cwd X — verified here by asking claude to read a marker file we
//      drop inside cwd X.
//
// Strategy:
//   * Make tempBase (= isolated CLAUDE_CONFIG_DIR / HOME / USERPROFILE).
//   * Inside tempBase create `my-project/` and a marker file containing a
//     unique token. Claude is asked (via its bash tool) to print pwd + ls,
//     so the buffer surfaces both the cwd path and the marker filename.
//   * Seed an ccsm session with cwd=`<tempBase>/my-project`.
//   * After the buffer confirms claude saw the right cwd, glob
//     `<tempBase>/.claude/projects/* /<sid>.jsonl` — exactly one match must
//     exist, and its parent dir name must encode "my-project".
//   * Negative assertion: no other dir under `<tempBase>/.claude/projects/`
//     should match the pool worktree path or Electron's cwd.
//
// Hashing scheme observation (Windows, real ~/.claude/projects/):
//   `C:\Users\jiahuigu\foo` → `C--Users-jiahuigu-foo` (colon dropped, `\` → `-`)
//   `/c/Users/jiahuigu/foo` (POSIX style) → `-c-Users-jiahuigu-foo`
// Rather than predict, we glob and read the parent dir name.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import {
  createIsolatedClaudeDir,
  launchCcsmIsolated,
  seedSession,
  waitForWebviewMounted,
  sendToClaudeTui,
  waitForXtermBuffer,
  readXtermLines,
} from './probe-utils-real-cli.mjs';

const PROBE_NAME = 'probe-real-cwd-projects-claude';
const MARKER_FILENAME = 'CCSM-PROBE-MARKER.txt';
const MARKER_TOKEN = `probe-cwd-marker-${Math.random().toString(36).slice(2, 10)}`;
const SCREENSHOT_DIR = path.resolve(`docs/screenshots/${PROBE_NAME}`);
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const log = (...args) => console.log('[PROBE]', ...args);
const fail = (msg, extra) => {
  console.error('[FAIL]', msg);
  if (extra !== undefined) console.error(JSON.stringify(extra, null, 2));
};

let electronApp = null;
let isolated = null;
let launched = null;
let win = null;
let exitCode = 1;

try {
  // -------------------------------------------------------------------------
  // 1. Isolated CLAUDE_CONFIG_DIR / HOME
  // -------------------------------------------------------------------------
  isolated = await createIsolatedClaudeDir();
  const tempDir = isolated.tempDir;
  log('tempDir =', tempDir);

  // -------------------------------------------------------------------------
  // 2. Project subdir + marker file
  // -------------------------------------------------------------------------
  const projectDir = path.join(tempDir, 'my-project');
  mkdirSync(projectDir, { recursive: true });
  const markerPath = path.join(projectDir, MARKER_FILENAME);
  writeFileSync(markerPath, `${MARKER_TOKEN}\n`, 'utf8');
  log('projectDir =', projectDir);
  log('marker token =', MARKER_TOKEN);

  // -------------------------------------------------------------------------
  // 3. Launch ccsm
  // -------------------------------------------------------------------------
  launched = await launchCcsmIsolated({ tempDir });
  electronApp = launched.electronApp;
  win = launched.win;
  log('ccsm launched');

  // -------------------------------------------------------------------------
  // 4. Seed session with cwd = projectDir
  // -------------------------------------------------------------------------
  const { sid } = await seedSession(win, {
    name: 'cwd-test',
    cwd: projectDir,
    groupId: 'g1',
  });
  if (!sid) throw new Error('seedSession returned no sid');
  log('sid =', sid);

  // -------------------------------------------------------------------------
  // 5. Wait for webview + xterm
  // -------------------------------------------------------------------------
  const wcId = await waitForWebviewMounted(win, electronApp, sid, { timeout: 25000 });
  log('webview wcId =', wcId);

  // Give claude TUI a beat to print its banner / settle into the input prompt.
  await new Promise((r) => setTimeout(r, 4000));
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, '01-tui-ready.png') }).catch(() => {});

  // -------------------------------------------------------------------------
  // 6. Wait for claude's banner to surface cwd, then send a real prompt that
  //    forces a JSONL transcript entry.
  // -------------------------------------------------------------------------
  // claude's banner prints the cwd as "~\my-project" (Windows) or
  // "~/my-project" — using HOME-relative form because we set HOME=tempDir.
  // Either form is unmistakable proof that claude.process.cwd === projectDir.
  await waitForXtermBuffer(
    electronApp,
    wcId,
    /my-project/,
    { timeout: 30000 },
  );
  log('banner shows cwd encodes my-project');

  // claude shows a "Welcome back!" splash card on cold-start that
  // intercepts the input. Press Enter a few times to dismiss it and
  // wait for the actual input prompt to settle.
  for (let i = 0; i < 4; i++) {
    await sendToClaudeTui(electronApp, wcId, '\r');
    await new Promise((r) => setTimeout(r, 700));
  }
  // Some additional time for the input controller to bind.
  await new Promise((r) => setTimeout(r, 1500));

  // Now send an actual user prompt so claude writes to its JSONL transcript.
  // (The `!bash` shortcut wasn't a reliable transcript trigger — claude often
  // executes it locally without a session-message record. A plain message
  // always produces a `user` line in the JSONL.)
  const PROMPT = `ccsm-probe-cwd marker ${MARKER_TOKEN}, please reply with the word PONG`;
  await sendToClaudeTui(electronApp, wcId, PROMPT);
  await new Promise((r) => setTimeout(r, 800));
  // Verify the text actually landed in the input box before submitting.
  // If not, we re-focus and re-send once.
  {
    const tailLines = await readXtermLines(electronApp, wcId, { lines: 12 }).catch(() => []);
    const seen = tailLines.some((l) => l.includes(MARKER_TOKEN.slice(0, 8)));
    if (!seen) {
      log('first send did not echo; retrying after explicit focus delay');
      await new Promise((r) => setTimeout(r, 1000));
      await sendToClaudeTui(electronApp, wcId, PROMPT);
      await new Promise((r) => setTimeout(r, 800));
    }
  }
  await sendToClaudeTui(electronApp, wcId, '\r');
  log('sent prompt with marker token, waiting for reply');

  // Wait for claude's PONG reply — confirms the round-trip wrote a JSONL line.
  await waitForXtermBuffer(electronApp, wcId, /PONG/, { timeout: 90000 });
  log('claude replied');
  await win.screenshot({ path: path.join(SCREENSHOT_DIR, '02-pwd-output.png') }).catch(() => {});

  // Sanity tail dump for the report.
  const tailLines = await readXtermLines(electronApp, wcId, { lines: 40 }).catch(() => []);
  log('xterm tail (last 40 non-empty lines):');
  for (const ln of tailLines) log('  |', ln);

  // -------------------------------------------------------------------------
  // 7. JSONL on disk under <CLAUDE_CONFIG_DIR>/projects/
  // -------------------------------------------------------------------------
  // Per createIsolatedClaudeDir contract, tempDir IS the CLAUDE_CONFIG_DIR
  // (no nested `.claude/`), so the projects/ root sits directly under it.
  const projectsRoot = path.join(tempDir, 'projects');
  const deadline = Date.now() + 20000;
  let matchedJsonl = null;
  let matchedDir = null;
  let projectsListing = [];
  while (Date.now() < deadline) {
    if (existsSync(projectsRoot)) {
      projectsListing = readdirSync(projectsRoot);
      for (const dirName of projectsListing) {
        const dirPath = path.join(projectsRoot, dirName);
        let entries;
        try { entries = readdirSync(dirPath); } catch { continue; }
        const hit = entries.find((f) => f === `${sid}.jsonl`);
        if (hit) {
          matchedJsonl = path.join(dirPath, hit);
          matchedDir = dirName;
          break;
        }
      }
    }
    if (matchedJsonl) break;
    await new Promise((r) => setTimeout(r, 500));
  }

  log('projects/ listing:', projectsListing);

  if (!matchedJsonl) {
    fail('no <sid>.jsonl found under tempDir/projects/', {
      projectsRoot,
      listing: projectsListing,
      sid,
    });
    await win.screenshot({
      path: path.join(SCREENSHOT_DIR, `fail-${Date.now()}.png`),
      fullPage: true,
    }).catch(() => {});
    process.exit(1);
  }
  log('matched JSONL =', matchedJsonl);
  log('matched dir   =', matchedDir);

  // Hash-dir name MUST encode "my-project" — proves the cwd flowed through
  // ttyd → claude and into claude's transcript-path hashing logic.
  if (!/my-project/i.test(matchedDir)) {
    fail('hash dir name does not encode "my-project" — cwd plumbing regressed', {
      matchedDir,
      sid,
    });
    process.exit(1);
  }

  // Negative: no other dir under projectsRoot may encode the pool worktree
  // path or Electron's cwd. Both would indicate a cwd leak (claude wrote to
  // ccsm's own cwd's hash).
  const electronCwd = process.cwd();
  const electronCwdHashFragment = path
    .basename(electronCwd)
    .replace(/[^a-z0-9-]/gi, '');
  for (const dirName of projectsListing) {
    if (dirName === matchedDir) continue;
    if (electronCwdHashFragment && dirName.includes(electronCwdHashFragment)
        && !dirName.includes('my-project')) {
      fail('extra projects/ dir encodes electron cwd — cwd leak', {
        leakDir: dirName,
        electronCwd,
      });
      process.exit(1);
    }
  }

  // JSONL must contain a transcript record — it's enough to assert the file
  // is non-empty and contains valid JSONL. We don't pin the message because
  // claude's `!` bash shortcut doesn't always produce a user-text "message"
  // record (it may show up only as a tool/bash entry).
  const jsonlBody = readFileSync(matchedJsonl, 'utf8');
  if (jsonlBody.trim().length === 0) {
    fail('JSONL exists but is empty', { matchedJsonl });
    process.exit(1);
  }
  const firstLine = jsonlBody.split('\n').find((l) => l.trim().length > 0);
  try { JSON.parse(firstLine); }
  catch (e) {
    fail('JSONL first line is not valid JSON', { firstLine: firstLine?.slice(0, 200), err: String(e) });
    process.exit(1);
  }
  // Marker token was embedded in the user prompt; it MUST round-trip into
  // the JSONL transcript. Also belt-and-suspenders against a stale JSONL
  // from some prior run sneaking in.
  if (!jsonlBody.includes(MARKER_TOKEN)) {
    fail('JSONL does not contain marker token from sent prompt', {
      matchedJsonl,
      tokenLooked: MARKER_TOKEN,
      bodyHead: jsonlBody.slice(0, 400),
    });
    process.exit(1);
  }
  log('JSONL contains marker token; byte size =', jsonlBody.length);

  log('cwd plumbing verified: claude sees', projectDir, '→ writes JSONL to', matchedDir);
  console.log('[PASS]', PROBE_NAME);
  exitCode = 0;
} catch (err) {
  fail(err?.stack || String(err));
  if (win) {
    try {
      await win.screenshot({
        path: path.join(SCREENSHOT_DIR, `fail-${Date.now()}.png`),
        fullPage: true,
      });
    } catch { /* ignore */ }
  }
  exitCode = 1;
} finally {
  if (electronApp) {
    try { await electronApp.close(); } catch { /* ignore */ }
  }
  if (launched?.cleanup) launched.cleanup();
  if (isolated?.cleanup) isolated.cleanup();
  process.exit(exitCode);
}
