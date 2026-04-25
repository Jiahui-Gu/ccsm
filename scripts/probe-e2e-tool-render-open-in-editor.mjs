// (#51 / P1-16) E2E probe: long tool stdout shows "Open in editor" button
// on hover; clicking it invokes the tool:open-in-editor IPC with the full
// stdout payload.
//
// Methodology:
//   - Frozen expectations BEFORE reading LongOutputView source.
//   - Mint MessageBlocks directly via the zustand store (matches existing
//     probe-e2e-tool-journey-render pattern). No real Bash, no claude.exe.
//   - We can't open the user's actual editor in CI — instead we monkeypatch
//     window.ccsm.toolOpenInEditor before triggering the click and assert
//     the payload it received.
//
// Run: `node scripts/probe-e2e-tool-render-open-in-editor.mjs`

import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, startBundleServer } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-probe-open-in-editor-'));
console.log(`[probe-e2e-tool-render-open-in-editor] userData = ${userDataDir}`);

const { port: PORT, close: closeServer } = await startBundleServer(root);

const results = [];
function record(name, expected, observed, pass, note = '') {
  results.push({ name, expected, observed, pass, note });
  const tag = pass ? 'PASS' : 'FAIL';
  console.log(`\n[${tag}] ${name}`);
  console.log(`  expected: ${expected}`);
  console.log(`  observed: ${observed}`);
  if (note) console.log(`  note: ${note}`);
}

const app = await electron.launch({
  args: ['.', `--user-data-dir=${userDataDir}`],
  cwd: root,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    CCSM_DEV_PORT: String(PORT),
    // Tells the tool:open-in-editor IPC handler to write the temp file
    // but skip launching the user's editor. Without this the probe would
    // spawn notepad/TextEdit/xdg-open on the host machine.
    CCSM_OPEN_IN_EDITOR_NOOP: '1',
  },
});

let exitCode = 0;
try {
  const win = await appWindow(app, { timeout: 30_000 });
  win.on('pageerror', (e) => console.error(`[pageerror] ${e.message}`));

  await win.waitForLoadState('domcontentloaded');
  await win.waitForFunction(() => !!window.__ccsmStore, null, { timeout: 20_000 });
  await win.waitForFunction(() => !!document.querySelector('aside'), null, { timeout: 10_000 });

  async function seed(blocks) {
    await win.evaluate(({ blocks }) => {
      const store = window.__ccsmStore;
      store.setState({
        groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
        sessions: [{
          id: 's-tool',
          name: 'tool-journey',
          state: 'idle',
          cwd: 'C:/x',
          model: 'claude-opus-4',
          groupId: 'g1',
          agentType: 'claude-code',
        }],
        activeId: 's-tool',
        messagesBySession: { 's-tool': blocks },
        startedSessions: { 's-tool': true },
        runningSessions: {},
        messageQueues: {},
      });
    }, { blocks });
    await win.waitForTimeout(250);
  }

  // ── Journey 1: short output → no "Open in editor" button ───────────────
  {
    // Use a non-shell tool name so we go through LongOutputView (not xterm).
    const shortText = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-short', toolUseId: 'tu_short', name: 'Read',
        brief: 'short.log', expanded: true, result: shortText, isError: false },
    ]);
    // Force-expand the block in case it isn't open by default.
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);
    const present = await win.evaluate(() =>
      !!document.querySelector('[data-testid="tool-output-open-in-editor"]'));
    record('short output (10 lines): button absent',
      'no [data-testid=tool-output-open-in-editor]',
      `present=${present}`,
      present === false);
  }

  // ── Journey 2: long output (60 lines) → button present ─────────────────
  {
    const longText = Array.from({ length: 60 }, (_, i) => `long-line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-long', toolUseId: 'tu_long', name: 'Read',
        brief: 'long.log', expanded: true, result: longText, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);
    const probe = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      if (!btn) return { present: false };
      const cs = getComputedStyle(btn);
      return {
        present: true,
        // hover-only: opacity should be 0 by default (group not hovered).
        // CI's headless Chromium doesn't naturally hover; so we expect 0.
        opacityDefault: cs.opacity,
        text: btn.textContent?.trim(),
      };
    });
    record('long output (60 lines): button present + hover-hidden by default',
      'button rendered with opacity 0 (revealed on group-hover)',
      JSON.stringify(probe),
      probe.present === true && probe.opacityDefault === '0');
  }

  // ── Journey 3: clicking the button writes a temp file via the real IPC ─
  // contextBridge fully freezes window.ccsm so we can't monkeypatch the
  // bridge from userspace. Instead the main-process handler honors
  // CCSM_OPEN_IN_EDITOR_NOOP (set on app launch above) to skip the actual
  // shell.openPath while still writing the file and returning {ok,path}.
  // We verify three things:
  //   1) the button's visible state transitions to "Opened" (renderer saw
  //      ok:true from the IPC),
  //   2) a fresh `claude-tool-output-*.txt` appears in os.tmpdir(),
  //   3) its contents match the full long stdout (no truncation).
  {
    const longText = Array.from({ length: 80 }, (_, i) => `payload-line ${i + 1}`).join('\n');
    await seed([
      { kind: 'tool', id: 't-click', toolUseId: 'tu_click', name: 'Read',
        brief: 'click.log', expanded: true, result: longText, isError: false },
    ]);
    await win.evaluate(() => {
      document.querySelectorAll('main button[aria-expanded="false"]').forEach((b) => b.click());
    });
    await win.waitForTimeout(150);

    const beforeFiles = new Set(
      fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('claude-tool-output-'))
    );
    await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      btn?.click();
    });
    await win.waitForTimeout(500);

    const buttonText = await win.evaluate(() => {
      const btn = document.querySelector('[data-testid="tool-output-open-in-editor"]');
      return btn?.textContent?.trim() ?? '';
    });
    const newFiles = fs
      .readdirSync(os.tmpdir())
      .filter((n) => n.startsWith('claude-tool-output-') && !beforeFiles.has(n));
    let contentMatches = false;
    let writtenLen = -1;
    if (newFiles.length === 1) {
      const txt = fs.readFileSync(path.join(os.tmpdir(), newFiles[0]), 'utf8');
      writtenLen = txt.length;
      contentMatches = txt === longText;
      // clean up the probe artifact
      try { fs.unlinkSync(path.join(os.tmpdir(), newFiles[0])); } catch { /* ignored */ }
    }
    const pass = buttonText === 'Opened' && newFiles.length === 1 && contentMatches;
    record('click → temp file written with full stdout, button shows "Opened"',
      `button="Opened", exactly 1 new claude-tool-output-*.txt, content.length === ${longText.length}`,
      `button="${buttonText}", newFiles=${JSON.stringify(newFiles)}, writtenLen=${writtenLen}`,
      pass);
  }

  console.log('\n=== consistency matrix ===');
  for (const r of results) {
    console.log(`  ${r.pass ? '[OK]' : '[XX]'} ${r.name}`);
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n=== totals: ${results.length - failed.length}/${results.length} passed ===`);
  if (failed.length > 0) exitCode = 1;
} catch (err) {
  console.error('[probe-e2e-tool-render-open-in-editor] threw:', err);
  exitCode = 1;
} finally {
  await app.close().catch(() => {});
  closeServer();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}
process.exit(exitCode);
