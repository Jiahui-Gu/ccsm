// Auth + REST sessions integration tests for the daemon HTTP server.
// Spins up the server on an ephemeral port, exercises every advertised
// auth path and the in-memory session CRUD stub.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type {
  CreateSessionResponse,
  ListSessionsResponse,
} from '@ccsm/shared';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';

const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef';
const GOOD_ORIGIN = 'http://localhost:1234';

let http: DaemonHttp;
let baseUrl: string;

function authedHeaders(extra: Record<string, string> = {}): HeadersInit {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Origin: GOOD_ORIGIN,
    'Content-Type': 'application/json',
    ...extra,
  };
}

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

describe('auth', () => {
  it('rejects POST /api/sessions with wrong token (401)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
        Origin: GOOD_ORIGIN,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects POST /api/sessions with missing Authorization (401)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: { Origin: GOOD_ORIGIN, 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });

  it('rejects POST /api/sessions with bad Origin (403)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'http://evil.com',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('accepts POST /api/sessions with missing Origin (same-origin per fetch spec) when token is valid (200)', async () => {
    // #672 — Browsers OMIT Origin on same-origin simple GET/HEAD; the daemon
    // must treat absent Origin as same-origin so useBootstrap's GET
    // /api/sessions does not 403 after page.reload(). Token is still required.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
  });

  it('still rejects POST /api/sessions with missing Origin when token is wrong (401, not 200)', async () => {
    // Defense: dropping Origin must NOT bypass token check.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong-token',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
  });
  // Note: cross-origin evil.com -> 403 is already covered by
  // "rejects POST /api/sessions with bad Origin (403)" above. #672 keeps
  // that defense intact (only missing Origin is treated as same-origin).

  it('serves GET / without auth (200 or 503 depending on dist presence)', async () => {
    const r = await fetch(`${baseUrl}/`);
    expect([200, 503]).toContain(r.status);
  });
});

// T2 #675 — Tauri origin whitelist + CORS for desktop shell.
describe('CORS + Tauri origin (T2 #675)', () => {
  it('accepts POST /api/sessions with Origin: tauri://localhost', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'tauri://localhost',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
    // CORS header echoes the allow-listed Tauri origin.
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    expect(r.headers.get('vary')).toContain('Origin');
  });

  it('rejects Origin: tauri://evil (only tauri://localhost is allow-listed)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'tauri://evil',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });

  it('OPTIONS /api/sessions preflight returns 200 + full CORS headers (no auth required)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'tauri://localhost',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
    const allowMethods = r.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods).toMatch(/GET/);
    expect(allowMethods).toMatch(/POST/);
    expect(allowMethods).toMatch(/DELETE/);
    expect(allowMethods).toMatch(/OPTIONS/);
    const allowHeaders = r.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders).toMatch(/Authorization/i);
    expect(allowHeaders).toMatch(/Content-Type/i);
  });

  it('OPTIONS preflight succeeds even with no Authorization header (preflight is pre-auth)', async () => {
    // Browsers (and Tauri webview) issue OPTIONS without credentials. The
    // daemon must respond with CORS headers BEFORE running requireAuth,
    // otherwise the actual request is never sent.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: { Origin: 'tauri://localhost' },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
  });

  it('attaches CORS headers even on auth failure (so browser can read 401 body)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: 'Bearer wrong',
        Origin: 'tauri://localhost',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(401);
    expect(r.headers.get('access-control-allow-origin')).toBe('tauri://localhost');
  });

  it('falls back to Allow-Origin: * when Origin header is absent', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });
});

describe('sessions CRUD (in-memory stub)', () => {
  it('creates, lists, and deletes a session', async () => {
    // POST creates.
    const create = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: authedHeaders(),
      body: JSON.stringify({}),
    });
    expect(create.status).toBe(200);
    const created = (await create.json()) as CreateSessionResponse;
    expect(typeof created.sid).toBe('string');
    expect(created.sid.length).toBeGreaterThan(0);
    expect(typeof created.createdAt).toBe('number');

    // GET lists it.
    const list = await fetch(`${baseUrl}/api/sessions`, {
      headers: authedHeaders(),
    });
    expect(list.status).toBe(200);
    const listed = (await list.json()) as ListSessionsResponse;
    const found = listed.sessions.find((s) => s.sid === created.sid);
    expect(found).toBeDefined();
    expect(found?.alive).toBe(true);

    // DELETE removes it.
    const del = await fetch(`${baseUrl}/api/sessions/${created.sid}`, {
      method: 'DELETE',
      headers: authedHeaders(),
    });
    expect(del.status).toBe(200);
    expect(await del.json()).toEqual({ ok: true });

    // GET again — gone from list.
    const list2 = await fetch(`${baseUrl}/api/sessions`, {
      headers: authedHeaders(),
    });
    const listed2 = (await list2.json()) as ListSessionsResponse;
    expect(listed2.sessions.find((s) => s.sid === created.sid)).toBeUndefined();
  });

  it('returns 404 when deleting an unknown sid', async () => {
    const r = await fetch(
      `${baseUrl}/api/sessions/this-sid-does-not-exist`,
      { method: 'DELETE', headers: authedHeaders() },
    );
    expect(r.status).toBe(404);
  });

  it('accepts http://127.0.0.1:* as a valid origin too', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'http://127.0.0.1:5173',
      },
    });
    expect(r.status).toBe(200);
  });
});
