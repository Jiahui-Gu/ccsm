// GET /token endpoint tests (Task #696).
//
// The web shell uses /token to bootstrap the bearer token without a URL
// `?token=` query string. The endpoint:
//   - is unauthenticated (daemon binds 127.0.0.1, exposes nothing extra
//     beyond what a local process can already read from CCSM_TOKEN)
//   - returns 200 + `{ token }` on GET
//   - applies CORS so the Tauri webview can read it
//   - rejects non-GET methods with 404 (mirrors the rest of the static surface)

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';

const TOKEN = 'test-token-696-do-not-use-in-prod-0123456789abcdef';

let http: DaemonHttp;
let baseUrl: string;

beforeAll(async () => {
  http = createDaemonHttp({ token: TOKEN });
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(0, '127.0.0.1', () => {
      http.server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = http.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => http.server.close(() => resolve()));
});

describe('GET /token', () => {
  it('returns the daemon bearer token without auth', async () => {
    const r = await fetch(`${baseUrl}/token`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { token: string };
    expect(body.token).toBe(TOKEN);
  });

  it('returns the token even when an Origin header is sent (CORS)', async () => {
    const r = await fetch(`${baseUrl}/token`, {
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).not.toBeNull();
    const body = (await r.json()) as { token: string };
    expect(body.token).toBe(TOKEN);
  });

  it('responds to OPTIONS preflight', async () => {
    const r = await fetch(`${baseUrl}/token`, {
      method: 'OPTIONS',
      headers: { Origin: 'http://localhost:5173' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('rejects POST with 404 (token is read-only)', async () => {
    const r = await fetch(`${baseUrl}/token`, { method: 'POST' });
    expect(r.status).toBe(404);
  });
});
