// Shared probe helpers. Pick the app renderer window (not DevTools) since
// dev mode opens DevTools detached and the order of windows is racy.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export async function appWindow(app, { timeout = 15000 } = {}) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const w of app.windows()) {
      try {
        const url = w.url();
        if (url.startsWith('http://localhost') || url.startsWith('file://')) return w;
      } catch {}
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('appWindow: no renderer window appeared in time');
}

// Spin up an isolated static server bound to a free port that serves the
// freshly-built `dist/renderer/`. Returns `{ port, close }`. Used by
// E2E probes that MUST load this worktree's bundle — never the developer's
// possibly-stale `npm run dev:web` instance on the default port 4100.
//
// Pair with `AGENTORY_DEV_PORT=<port>` in the electron launch env so
// `electron/main.ts` points the BrowserWindow at our server instead of
// the well-known dev port.
export async function startBundleServer(rootDir) {
  const distDir = path.resolve(rootDir, 'dist/renderer');
  if (!fs.existsSync(path.join(distDir, 'bundle.js'))) {
    throw new Error('dist/renderer/bundle.js missing — run `npm run build` first');
  }
  const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.woff2': 'font/woff2',
    '.woff': 'font/woff',
    '.png': 'image/png',
    '.json': 'application/json'
  };
  const server = http.createServer((req, res) => {
    const reqPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const filePath = reqPath === '/' ? 'index.html' : reqPath.replace(/^\//, '');
    const abs = path.join(distDir, filePath);
    if (!abs.startsWith(distDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[path.extname(abs).toLowerCase()] || 'application/octet-stream');
    fs.createReadStream(abs).pipe(res);
  });
  const port = await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server.address().port));
  });
  return { port, close: () => server.close() };
}

// dnd-kit's PointerSensor listens for native PointerEvents. Playwright's
// `mouse.down/move/up` API dispatches MouseEvents — Chromium does not
// synthesize PointerEvents from those in a way dnd-kit picks up reliably,
// so the sensor's activation constraint never trips. We dispatch real
// PointerEvent instances on the document instead, which routes through
// React's synthetic event system and into dnd-kit's listeners.
//
// `holdMs` keeps the press alive over the target before release — needed
// for collapsed-group hover-to-expand (default 400ms in Sidebar).
export async function dndDrag(win, sourceSelector, targetSelector, opts = {}) {
  const { holdMs = 0, steps = 18, settleMs = 250, postReleaseMs = 350 } = opts;
  const src = win.locator(sourceSelector).first();
  const tgt = win.locator(targetSelector).first();
  await src.waitFor({ state: 'visible', timeout: 5000 });
  await tgt.waitFor({ state: 'visible', timeout: 5000 });
  const sb = await src.boundingBox();
  const tb = await tgt.boundingBox();
  if (!sb || !tb) throw new Error('dndDrag: missing boundingBox');
  const sx = sb.x + sb.width / 2;
  const sy = sb.y + sb.height / 2;
  const tx = tb.x + tb.width / 2;
  const ty = tb.y + tb.height / 2;
  // Press on the source itself so the listeners on that element wire up.
  await src.dispatchEvent('pointerdown', {
    button: 0,
    clientX: sx,
    clientY: sy,
    pointerType: 'mouse',
    pointerId: 1,
    isPrimary: true
  });
  // dnd-kit attaches pointermove/pointerup on the document after activation —
  // dispatch on document to satisfy both pre- and post-activation listeners.
  for (let i = 1; i <= steps; i++) {
    const px = sx + ((tx - sx) * i) / steps;
    const py = sy + ((ty - sy) * i) / steps;
    await win.evaluate(
      ({ px, py }) =>
        document.dispatchEvent(
          new PointerEvent('pointermove', {
            clientX: px,
            clientY: py,
            bubbles: true,
            pointerType: 'mouse',
            pointerId: 1,
            isPrimary: true
          })
        ),
      { px, py }
    );
    await win.waitForTimeout(15);
  }
  await win.waitForTimeout(settleMs);
  if (holdMs > 0) await win.waitForTimeout(holdMs);
  await win.evaluate(
    ({ tx, ty }) =>
      document.dispatchEvent(
        new PointerEvent('pointerup', {
          clientX: tx,
          clientY: ty,
          bubbles: true,
          pointerType: 'mouse',
          pointerId: 1,
          isPrimary: true
        })
      ),
    { tx, ty }
  );
  await win.waitForTimeout(postReleaseMs);
}

// Allocate an isolated electron userData directory under os.tmpdir so probes
// never share persisted state with the dev user or each other. Returns the
// path plus a cleanup function the caller can invoke in finally.
export function isolatedUserData(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix + '-'));
  return {
    dir,
    cleanup() {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {}
    }
  };
}

// Wait for the renderer's zustand store to finish hydration (rendering
// implies React has mounted, which implies hydrateStore().finally() has run).
// Then forcibly replace state with the fixture and yield long enough for
// React to flush. Use this instead of raw setState — the store is async-
// hydrated and a bare setState can race the persisted-state apply.
export async function seedStore(win, state) {
  await win.waitForFunction(
    () => !!window.__agentoryStore && document.querySelector('aside') !== null,
    null,
    { timeout: 20_000 }
  );
  await win.evaluate((s) => {
    const store = window.__agentoryStore;
    if (!store) throw new Error('__agentoryStore missing on window — App.tsx no longer exposes it?');
    store.setState(s);
  }, state);
  await win.waitForTimeout(200);
}
