// MERGED INTO scripts/harness-ui.mjs (case id=sidebar-align; see harness file).
// This per-file probe is kept as a breadcrumb. The runner skips it via MERGED_INTO_HARNESS.
// Measure sidebar vs chat-panel top/bottom alignment. Expectation: the two
// column top edges and bottom edges should match within 1px. Before the fix
// the sidebar is flush to window (top=0, bottom=vh) while <main> has my-2
// (~8px gap top and bottom), so the two columns don't line up visually.
import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appWindow } from './probe-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

function fail(msg) {
  console.error(`\n[probe-e2e-sidebar-align] FAIL: ${msg}`);
  process.exit(1);
}

const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, NODE_ENV: 'development' }
});

const win = await appWindow(app);
await win.waitForLoadState('domcontentloaded');
// The empty ("No sessions yet") main panel exhibits the same my-2 asymmetry
// as the populated one — no need to seed the store here.
await win.waitForFunction(() => !!document.querySelector('main') && !!document.querySelector('aside'), null, { timeout: 10000 });
await win.waitForTimeout(200);

const geo = await win.evaluate(() => {
  const aside = document.querySelector('aside');
  const main = document.querySelector('main');
  if (!aside || !main) return null;
  const a = aside.getBoundingClientRect();
  const m = main.getBoundingClientRect();
  return {
    aside: { top: a.top, bottom: a.bottom, left: a.left, right: a.right },
    main: { top: m.top, bottom: m.bottom, left: m.left, right: m.right },
    vh: window.innerHeight
  };
});
if (!geo) { await app.close(); fail('no aside or main element'); }

const topDelta = Math.abs(geo.aside.top - geo.main.top);
const botDelta = Math.abs(geo.aside.bottom - geo.main.bottom);
const tolerance = 1;

console.log('  aside top/bot:', geo.aside.top.toFixed(1), geo.aside.bottom.toFixed(1));
console.log('  main  top/bot:', geo.main.top.toFixed(1), geo.main.bottom.toFixed(1));
console.log('  vh =', geo.vh);

if (topDelta > tolerance) {
  await app.close();
  fail(`top edges misaligned: aside=${geo.aside.top.toFixed(1)} main=${geo.main.top.toFixed(1)} delta=${topDelta.toFixed(1)}`);
}
if (botDelta > tolerance) {
  await app.close();
  fail(`bottom edges misaligned: aside=${geo.aside.bottom.toFixed(1)} main=${geo.main.bottom.toFixed(1)} delta=${botDelta.toFixed(1)}`);
}

console.log('\n[probe-e2e-sidebar-align] OK');
await app.close();
