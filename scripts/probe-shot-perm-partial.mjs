// Visual capture probe for #306 — snapshots the PermissionPromptBlock for a
// 3-hunk MultiEdit so the PR body can show before/after side-by-side. Not a
// pass/fail probe; just emits PNGs to dogfood-logs/perm-block-partial-306/.
//
// This is a purpose-built screenshot-capture file (probe-shot-*), distinct from
// the e2e harness-perm.mjs which covers pass/fail assertions including
// `permission-partial-accept`. `feedback_e2e_discipline.md` says extend before
// creating — no existing probe-shot-* file covers the PermissionPromptBlock
// surface, so this is the logical home. See PR #250 description.
//
// Variants (run all three to regenerate the three screenshots tracked by the
// PR body):
//   --variant=before         flat-summary surface (legacy code path — same
//                            component, onAllowPartial stripped from options
//                            so hasHunkSelection is false. Faithful render of
//                            what users saw before #306 for MultiEdit tools.)
//   --variant=after          3 hunks, all checked (default partial-selection
//                            UI on first interaction — parity with whole-allow).
//   --variant=after-partial  middle hunk deselected → "Allow selected (2/3)"
//                            + dimmed overlay on the deselected hunk.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = path.join(root, 'dogfood-logs/perm-block-partial-306');
fs.mkdirSync(outDir, { recursive: true });

const variant = process.argv.find((a) => a.startsWith('--variant='))?.slice('--variant='.length) ?? 'after';
const filename = process.argv.find((a) => a.startsWith('--out='))?.slice('--out='.length) ?? `${variant}.png`;

if (!['before', 'after', 'after-partial'].includes(variant)) {
  throw new Error(`unknown --variant=${variant}; expected one of before|after|after-partial`);
}

// Isolated userData so we never touch the dev user's sessions DB.
const ud = isolatedUserData('probe-shot-perm');

// Also sanitize HOME so we don't inherit ~/.claude skill injection into the
// launched electron process (see feedback note on probe skill injection).
const cleanHome = fs.mkdtempSync(path.join(os.tmpdir(), 'probe-home-'));
fs.mkdirSync(path.join(cleanHome, '.claude'), { recursive: true });

const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: {
    ...process.env,
    HOME: cleanHome,
    USERPROFILE: cleanHome,
    NODE_ENV: 'production',
    CCSM_PROD_BUNDLE: '1'
  }
});

try {
  const win = await appWindow(app, { timeout: 30_000 });
  await win.waitForLoadState('domcontentloaded');

  // Wait for BOTH the store exposed AND the sidebar mounted (same bar as
  // seedStore in probe-utils). Guarantees App.tsx useEffects have run once.
  await win.waitForFunction(
    () => !!window.__ccsmStore && document.querySelector('aside') !== null,
    null,
    { timeout: 30_000 }
  );

  // Seed a minimal session, mark tutorial seen (so the right pane mounts
  // ChatStream instead of the onboarding landing), and — for the "before"
  // variant — strip the store's partial-resolve action so renderBlock passes
  // `onAllowPartial={undefined}` and PermissionPromptBlock falls back to the
  // legacy flat key/value summary.
  await win.evaluate((v) => {
    const store = window.__ccsmStore;
    const patch = {
      tutorialSeen: true,
      cliStatus: { state: 'found', binaryPath: '<harness>', version: null },
      groups: [{ id: 'g1', name: 'G1', collapsed: false, kind: 'normal' }],
      sessions: [{ id: 's-shot', name: 'shot', state: 'idle', cwd: 'C:/x', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }],
      activeId: 's-shot',
      messagesBySession: { 's-shot': [] }
    };
    if (v === 'before') {
      // Disable partial-resolve action so the rendered block takes the legacy
      // flat-summary path. This is exactly the code path users hit before #306
      // for any Edit/Write/MultiEdit, because `resolvePermissionPartial` did
      // not exist on the store.
      patch.resolvePermissionPartial = undefined;
    }
    store.setState(patch);
  }, variant);
  await win.waitForTimeout(300);

  await win.evaluate(() => {
    const s = window.__ccsmStore.getState();
    s.appendBlocks(s.activeId, [{
      kind: 'waiting',
      id: 'wait-SHOT',
      prompt: 'MultiEdit /tmp/example.ts (3 edits)',
      intent: 'permission',
      requestId: 'SHOT',
      toolName: 'MultiEdit',
      toolInput: {
        file_path: '/tmp/example.ts',
        edits: [
          { old_string: 'const greeting = "hi"', new_string: 'const greeting = "hello, world"' },
          { old_string: 'function add(a, b) { return a+b; }', new_string: 'function add(a: number, b: number): number {\n  return a + b;\n}' },
          { old_string: 'export default add;', new_string: 'export { add };\nexport default add;' }
        ]
      }
    }]);
  });

  const heading = win.locator('text=Permission required').first();
  await heading.waitFor({ state: 'visible', timeout: 10_000 });
  await win.waitForTimeout(400);

  // Optional: deselect a hunk before shooting to show the dimmed-overlay state.
  if (variant === 'after-partial') {
    const ok = await win.evaluate(() => {
      const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
      if (boxes.length < 3) return { ok: false, count: boxes.length };
      boxes[1].click();
      return { ok: true, count: boxes.length };
    });
    if (!ok.ok) {
      throw new Error(`after-partial variant expected >=3 hunk checkboxes; got ${ok.count}. Per-hunk render path is not firing.`);
    }
    await win.waitForTimeout(300);
  }

  // Sanity assertion per variant: refuses to write the PNG if the surface
  // isn't what the file name claims. Prevents a future regression from
  // silently producing a misleading screenshot.
  const surface = await win.evaluate(() => {
    const boxes = document.querySelectorAll('[data-perm-hunk-checkbox]');
    const allowBtn = document.querySelector('[data-perm-action="allow"]');
    const allBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'All');
    const noneBtn = Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === 'None');
    return {
      hunkCount: boxes.length,
      allowLabel: allowBtn?.textContent?.trim() ?? null,
      hasAllToolbar: !!allBtn,
      hasNoneToolbar: !!noneBtn
    };
  });

  if (variant === 'before') {
    if (surface.hunkCount !== 0) {
      throw new Error(`"before" variant expected flat summary (0 hunk checkboxes); got ${surface.hunkCount}. Onboarding / legacy path is not firing.`);
    }
  } else {
    if (surface.hunkCount !== 3) {
      throw new Error(`"${variant}" variant expected 3 hunk checkboxes; got ${surface.hunkCount}.`);
    }
    if (!surface.hasAllToolbar || !surface.hasNoneToolbar) {
      throw new Error(`"${variant}" variant expected All/None toolbar; got all=${surface.hasAllToolbar} none=${surface.hasNoneToolbar}.`);
    }
    if (variant === 'after' && !/Allow selected \(3\/3\)/i.test(surface.allowLabel ?? '')) {
      throw new Error(`"after" variant expected "Allow selected (3/3)" (all checked by default); got "${surface.allowLabel}".`);
    }
    if (variant === 'after-partial' && !/Allow selected \(2\/3\)/i.test(surface.allowLabel ?? '')) {
      throw new Error(`"after-partial" variant expected "Allow selected (2/3)"; got "${surface.allowLabel}".`);
    }
  }

  const container = await win.locator('[role="alertdialog"]').first();
  const out = path.join(outDir, filename);
  await container.screenshot({ path: out });
  console.log(`[shot] wrote ${out} (variant=${variant}) — ${JSON.stringify(surface)}`);
} finally {
  try { await app.close(); } catch {}
  try { ud.cleanup(); } catch {}
  try { fs.rmSync(cleanHome, { recursive: true, force: true }); } catch {}
}
