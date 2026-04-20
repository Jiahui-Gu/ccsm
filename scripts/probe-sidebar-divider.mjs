import { _electron as electron } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const app = await electron.launch({ args: ['.'], cwd: root, env: { ...process.env, NODE_ENV: 'development' } });
const win = await app.firstWindow();
await win.waitForLoadState('domcontentloaded');
await win.waitForTimeout(2500);

// Make sure sidebar is rendered and there is at least one session so main is mounted.
await win.evaluate(() => {
  const s = window.__agentoryStore.getState();
  if (s.sessions.length === 0) s.createSession('C:\\Users\\jiahuigu\\projects\\agentory-next');
});
await win.waitForTimeout(600);

// Geometry of every horizontal border in sidebar + main's left border.
const geom = await win.evaluate(() => {
  const out = { aside: null, asideStyle: null, inner: null, innerStyle: null, sidebarLines: [], main: null };
  const aside = document.querySelector('aside');
  if (aside) {
    const r = aside.getBoundingClientRect();
    const cs = getComputedStyle(aside);
    out.aside = { left: r.left, right: r.right, width: r.width };
    out.asideStyle = { width: cs.width, padding: cs.padding, border: cs.borderWidth, boxSizing: cs.boxSizing, transform: cs.transform };
  }
  const inner = document.querySelector('aside > div');
  if (inner) {
    const r = inner.getBoundingClientRect();
    const cs = getComputedStyle(inner);
    out.inner = { left: r.left, right: r.right, width: r.width };
    out.innerStyle = { width: cs.width, padding: cs.padding, boxSizing: cs.boxSizing };
    inner.querySelectorAll('.border-t').forEach((el, i) => {
      const rr = el.getBoundingClientRect();
      out.sidebarLines.push({ i, left: rr.left, right: rr.right, width: rr.width });
    });
  }
  const main = document.querySelector('main');
  if (main) {
    const r = main.getBoundingClientRect();
    out.main = { left: r.left, right: r.right };
  }
  return out;
});
console.log(JSON.stringify(geom, null, 2));

await win.screenshot({ path: 'scripts/_sidebar-screenshot.png', fullPage: false });
console.log('screenshot saved to scripts/_sidebar-screenshot.png');
await app.close();
