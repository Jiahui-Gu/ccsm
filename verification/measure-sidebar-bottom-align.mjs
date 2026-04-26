// Verification (NOT an e2e probe) for task #308 — symmetric sidebar
// top/bottom padding + Settings/Import bottom edge aligned with InputBar
// bottom edge.
//
// Pass condition (within ±2px sub-pixel tolerance):
//   1. align-gap = inputBarBottom - settingsBtnBottom == 0
//   2. top-padding = newSessionBtnTop - sidebarTop
//      bottom-padding = sidebarBottom - settingsBtnBottom
//   3. top-padding == bottom-padding
//
// Output: verification/sidebar-bottom-align.png + console JSON.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from '../scripts/probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = __dirname;
const tag = process.argv[2] || 'after'; // pass "before" / "after"

const ud = isolatedUserData(`ccsm-verify-bottom-align-${tag}`);
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, CCSM_PROD_BUNDLE: '1' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');

await seedStore(win, {
  groups: [
    { id: 'g1', name: 'Alpha', collapsed: false, kind: 'normal' }
  ],
  sessions: [
    { id: 's1', name: 'one', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
  ],
  activeId: 's1',
  focusedGroupId: 'g1'
});

await win.waitForTimeout(500);

const measurements = await win.evaluate(() => {
  const aside = document.querySelector('aside');
  if (!aside) throw new Error('no aside');
  const asideRect = aside.getBoundingClientRect();

  function findBtn(re) {
    return Array.from(document.querySelectorAll('aside button'))
      .find((b) => re.test(b.getAttribute('aria-label') || '') || re.test(b.textContent || ''));
  }

  // Top: New Session button (a <button> with text "New session" in expanded state)
  const newSessionBtn = Array.from(document.querySelectorAll('aside button'))
    .find((b) => /new session|新会话|新建会话/i.test(b.textContent || ''));
  // Bottom-left: Settings button (text)
  const settingsBtn = Array.from(document.querySelectorAll('aside button'))
    .find((b) => /settings|设置/i.test(b.textContent || ''));
  // Bottom-right: Import icon button (aria-label)
  const importBtn = findBtn(/import|导入/i);

  // InputBar root — has data-input-bar on the textarea; root is its
  // closest ancestor with px-3 pt-2 pb-3 (relative). Easier: find the
  // textarea, walk up to first parent that is a sibling of <main>'s
  // direct children (i.e. the InputBar wrapper).
  const textarea = document.querySelector('textarea[data-input-bar]');
  // The "input box" the user perceives is the bordered rounded container
  // wrapping the textarea (`rounded-md border bg-bg-elevated`), not the
  // InputBar's outer padding wrapper.
  const inputBox = textarea ? textarea.parentElement : null;
  let inputBarRoot = textarea ? textarea.closest('main > div') : null;
  // Fallback — the wrapper is directly inside <main>; pick last div child of main.
  if (!inputBarRoot) {
    const mainEl = document.querySelector('main');
    if (mainEl) {
      const children = Array.from(mainEl.children).filter((c) => c.tagName === 'DIV');
      inputBarRoot = children[children.length - 1] || null;
    }
  }

  function rect(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      top: +r.top.toFixed(2),
      bottom: +r.bottom.toFixed(2),
      left: +r.left.toFixed(2),
      right: +r.right.toFixed(2),
      height: +r.height.toFixed(2)
    };
  }

  const sidebar = rect(aside);
  const newSession = rect(newSessionBtn);
  const settings = rect(settingsBtn);
  const importR = rect(importBtn);
  const inputBar = rect(inputBarRoot);
  const inputBoxR = rect(inputBox);

  const topPadding = newSession ? +(newSession.top - sidebar.top).toFixed(2) : null;
  const bottomPadding = settings ? +(sidebar.bottom - settings.bottom).toFixed(2) : null;
  // Align gap measured against the visible bordered input box (what the user
  // calls "输入框"), not the outer wrapper which is flush to the panel bottom.
  const alignGap = (inputBoxR && settings) ? +(inputBoxR.bottom - settings.bottom).toFixed(2) : null;
  const alignGapOuter = (inputBar && settings) ? +(inputBar.bottom - settings.bottom).toFixed(2) : null;

  return {
    sidebar,
    newSession,
    settings,
    import: importR,
    inputBar,
    inputBox: inputBoxR,
    topPadding,
    bottomPadding,
    alignGap,
    alignGapOuter
  };
});

console.log(JSON.stringify({ tag, ...measurements }, null, 2));
fs.writeFileSync(
  path.join(outDir, `sidebar-bottom-align-${tag}.json`),
  JSON.stringify({ tag, ...measurements }, null, 2)
);

// Full-window screenshot showing both sidebar bottom and main InputBar bottom.
await win.screenshot({ path: path.join(outDir, `sidebar-bottom-align-${tag}.png`) });

await app.close();
ud.cleanup();

const tol = 2.0;
const fails = [];
if (measurements.alignGap == null) fails.push('alignGap not measurable');
else if (Math.abs(measurements.alignGap) > tol) fails.push(`alignGap=${measurements.alignGap} (>${tol}px)`);
if (measurements.topPadding != null && measurements.bottomPadding != null) {
  if (Math.abs(measurements.topPadding - measurements.bottomPadding) > tol) {
    fails.push(`top vs bottom padding mismatch: ${measurements.topPadding} vs ${measurements.bottomPadding}`);
  }
}

if (fails.length && tag === 'after') {
  console.error('\n[bottom-align] FAIL:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\n[bottom-align] tag=${tag}; alignGap=${measurements.alignGap}, top=${measurements.topPadding}, bottom=${measurements.bottomPadding}`);
