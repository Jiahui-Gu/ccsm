// Shared probe helpers. Pick the app renderer window (not DevTools) since
// dev mode opens DevTools detached and the order of windows is racy.
import http from 'node:http';
import fs from 'node:fs';
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
