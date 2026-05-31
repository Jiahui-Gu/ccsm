// electron/remote/oauthLoopback.ts
import http from 'node:http';
import { AddressInfo } from 'node:net';

type Server = http.Server;

export function runOauthLoopback(opts: {
  workerOrigin: string;
  openExternal?: (url: string) => void | Promise<void>;
  createServer?: (handler: http.RequestListener) => Server;
  timeoutMs?: number;
}): Promise<{ authCode: string }> {
  const open =
    opts.openExternal ??
    ((url: string) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { shell } = require('electron') as typeof import('electron');
      return shell.openExternal(url);
    });
  const makeServer = opts.createServer ?? ((h) => http.createServer(h));
  const timeoutMs = opts.timeoutMs ?? 120_000;

  return new Promise<{ authCode: string }>((resolve, reject) => {
    let done = false;

    const server = makeServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/') {
        res.writeHead(404).end();
        return;
      }
      const authCode = url.searchParams.get('authCode');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><title>Signed in</title><body>You can close this window.');
      if (typeof authCode === 'string' && authCode) {
        finish(() => resolve({ authCode }));
      }
    });

    const timer = setTimeout(() => finish(() => reject(new Error('oauth timeout'))), timeoutMs);

    function finish(fn: () => void): void {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        server.close();
      } catch {
        /* ignore */
      }
      fn();
    }

    server.on('error', (err) => finish(() => reject(err)));
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo | null;
      if (!addr) {
        finish(() => reject(new Error('loopback: no address')));
        return;
      }
      const startUrl = `${opts.workerOrigin}/auth/github/desktop-start?port=${addr.port}`;
      Promise.resolve(open(startUrl)).catch((err) => finish(() => reject(err)));
    });
  });
}
