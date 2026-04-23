// Verification (NOT an e2e probe) for the rail-X alignment fix.
//
// Per design doc docs/design/sidebar-alignment-plan.md §5 (recommendation A),
// the 5 right-anchored sidebar affordances should all share the same X
// distance from the sidebar's right edge:
//   1. Search button       (top action row)
//   2. New-group +         (Groups header)
//   3. New-session +       (per-group header)
//   4. Selected blue dot   (active session row)
//   5. Import button       (bottom action row)
//
// The doc's literal "28px from right edge" assumed a 16px root font; the
// app's `--app-font-size` defaults to 14px so the rem-scaled rail naturally
// lands at 24.5px. The pass condition therefore checks **mutual equality
// across all 5 elements within ±1px** (sub-pixel render tolerance), with
// the baseline taken from the unmodified search button.
//
// Outputs:
//   verification/measurements.json   — five centerX + fromRightEdge values
//   verification/sidebar-align.png   — full sidebar screenshot
import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { appWindow, isolatedUserData, seedStore } from '../scripts/probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const outDir = __dirname;

const ud = isolatedUserData('agentory-verify-rail-x');
const app = await electron.launch({
  args: ['.', `--user-data-dir=${ud.dir}`],
  cwd: root,
  env: { ...process.env, AGENTORY_PROD_BUNDLE: '1' }
});
const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');

await seedStore(win, {
  groups: [
    { id: 'g1', name: 'Alpha', collapsed: false, kind: 'normal' },
    { id: 'g2', name: 'Bravo', collapsed: false, kind: 'normal' }
  ],
  sessions: [
    { id: 's1', name: 'one', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' },
    { id: 's2', name: 'two', state: 'idle', cwd: '~', model: 'claude-opus-4', groupId: 'g1', agentType: 'claude-code' }
  ],
  activeId: 's1',
  focusedGroupId: 'g1'
});

await win.waitForTimeout(400);

const measurements = await win.evaluate(() => {
  const aside = document.querySelector('aside');
  if (!aside) throw new Error('no aside');
  const rightEdge = aside.getBoundingClientRect().right;

  function measure(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    return { centerX: +cx.toFixed(2), fromRightEdge: +(rightEdge - cx).toFixed(2) };
  }
  function findBtn(re) {
    return Array.from(document.querySelectorAll('aside button'))
      .find((b) => re.test(b.getAttribute('aria-label') || ''));
  }

  const search = measure(findBtn(/search|搜索/i));
  const newGroup = measure(findBtn(/new group|新.*分组|新建.*组/i));
  const newSession = measure(
    document.querySelector('[data-group-header-id="g1"]')?.querySelector(
      'button[aria-label*="new session" i], button[aria-label*="新建" i]'
    )
  );
  const blueDot = measure(
    Array.from(document.querySelectorAll('aside [aria-label]')).find((el) =>
      /open in chat|在.*打开|打开.*会话/i.test(el.getAttribute('aria-label') || '')
    )
  );
  const importBtn = measure(findBtn(/import|导入/i));

  return {
    sidebarRightEdge: +rightEdge.toFixed(2),
    search,
    newGroup,
    newSession,
    blueDot,
    import: importBtn
  };
});

fs.writeFileSync(path.join(outDir, 'measurements.json'), JSON.stringify(measurements, null, 2));
await win.locator('aside').screenshot({ path: path.join(outDir, 'sidebar-align.png') });

console.log(JSON.stringify(measurements, null, 2));

const tolerance = 1.0;
const checks = ['search', 'newGroup', 'newSession', 'blueDot', 'import'];
const baseline = measurements.search?.fromRightEdge;
const fails = [];
if (baseline == null) fails.push('search baseline missing');
for (const k of checks) {
  const m = measurements[k];
  if (!m) { fails.push(`${k}: NOT FOUND`); continue; }
  if (baseline != null && Math.abs(m.fromRightEdge - baseline) > tolerance) {
    fails.push(`${k}: fromRightEdge=${m.fromRightEdge} (baseline ${baseline}±${tolerance})`);
  }
}

await app.close();
ud.cleanup();

if (fails.length) {
  console.error('\n[verify-rail-x] FAIL:\n' + fails.map((f) => '  - ' + f).join('\n'));
  process.exit(1);
}
console.log(`\n[verify-rail-x] OK — all 5 elements within ±${tolerance}px of baseline ${baseline}px from sidebar right edge.`);

