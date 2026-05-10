// Auth + REST sessions integration tests for the daemon HTTP server.
// Spins up the server on an ephemeral port, exercises every advertised
// auth path and the in-memory session CRUD stub.

import type { AddressInfo } from 'node:net';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type {
  CreateSessionResponse,
  ListSessionsResponse,
} from '@ccsm/shared';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';
import { classifyOrigin } from '../src/auth.mjs';

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

// S2 #702 — Cloudflare Pages prod origin allow-list + Chrome PNA preflight.
// The web SPA is hosted at `https://ccsm-worker.jiahuigu.workers.dev`. From the user's browser
// it issues cross-origin loopback fetches into the daemon. Only the exact
// production origin is allowed; spoof variants and PR-preview subdomains are
// rejected. Chrome 120+ PNA further requires the daemon to opt-in to private
// network access via a preflight echo header.
describe('S2 #702 — Cloudflare Pages origin allow-list (classifyOrigin)', () => {
  it('classifyOrigin("https://ccsm-worker.jiahuigu.workers.dev") === "allowed" (prod host)', () => {
    expect(classifyOrigin('https://ccsm-worker.jiahuigu.workers.dev')).toBe('allowed');
  });

  it('classifyOrigin("https://ccsm-worker-evil.jiahuigu.workers.dev") === "rejected" (sibling spoof)', () => {
    expect(classifyOrigin('https://ccsm-worker-evil.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('classifyOrigin("https://ccsm-worker.jiahuigu.workers.dev.attacker.com") === "rejected" (suffix spoof)', () => {
    expect(classifyOrigin('https://ccsm-worker.jiahuigu.workers.dev.attacker.com')).toBe('rejected');
  });

  it('classifyOrigin("http://ccsm-worker.jiahuigu.workers.dev") === "rejected" (http stripped, must be https)', () => {
    expect(classifyOrigin('http://ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('classifyOrigin("https://abc123-ccsm-worker.jiahuigu.workers.dev") === "rejected" (PR-preview default off)', () => {
    // T8 will introduce an opt-in flag for preview deploys; until then,
    // every preview subdomain MUST be rejected to keep the prod attack
    // surface tight.
    expect(classifyOrigin('https://abc123-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('classifyOrigin(undefined) === "absent" (regression for #672 same-origin)', () => {
    // Browsers omit Origin on same-origin GET/HEAD; daemon treats absent
    // as same-origin. This must keep working alongside the new workers.dev
    // allow-list entry.
    expect(classifyOrigin(undefined)).toBe('absent');
  });

  it('keeps tauri://localhost === "allowed" (T2 #675 regression)', () => {
    expect(classifyOrigin('tauri://localhost')).toBe('allowed');
  });
});

describe('R-53 #175 — workers.dev integration through the HTTP server', () => {
  it('accepts POST /api/sessions with Origin: https://ccsm-worker.jiahuigu.workers.dev (200)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://ccsm-worker.jiahuigu.workers.dev',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ccsm-worker.jiahuigu.workers.dev');
  });

  it('rejects POST /api/sessions with Origin: https://ccsm-worker-evil.jiahuigu.workers.dev (403)', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://ccsm-worker-evil.jiahuigu.workers.dev',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(403);
  });
});

// S2 T2 (Task #727) — verify applyCorsHeaders + ws upgrade auto-inherit T1's
// classifyOrigin allow-list for `https://ccsm-worker.jiahuigu.workers.dev`. T1 (PR #1141) added
// the host to classifyOrigin; this group asserts that the HTTP CORS path
// (applyCorsHeaders in http.mts) and the OPTIONS preflight handler echo the
// origin (NOT `*`) and emit the standard CORS response headers — without any
// further changes to http.mts. Companion ws.test.ts case covers ws.mts.
describe('S2 T2 #727 — applyCorsHeaders auto-inherits ccsm-worker.jiahuigu.workers.dev (no src changes)', () => {
  it('echoes Origin (not *) on a normal POST from https://ccsm-worker.jiahuigu.workers.dev', async () => {
    // applyCorsHeaders branch: origin defined && classifyOrigin === 'allowed'
    // → ACAO echoes `origin`. The * fallback is exercised by the
    // "falls back to Allow-Origin: * when Origin header is absent" case.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${TOKEN}`,
        Origin: 'https://ccsm-worker.jiahuigu.workers.dev',
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ccsm-worker.jiahuigu.workers.dev');
    expect(r.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(r.headers.get('vary')).toContain('Origin');
  });

  it('OPTIONS preflight from https://ccsm-worker.jiahuigu.workers.dev → 200 + echo + standard CORS headers', async () => {
    // Standard CORS preflight (no PNA): different from the PNA echo case
    // above — this asserts the baseline preflight response is correct when
    // the origin is the prod Pages host. Pre-auth: no Authorization header.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ccsm-worker.jiahuigu.workers.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ccsm-worker.jiahuigu.workers.dev');
    expect(r.headers.get('access-control-allow-origin')).not.toBe('*');
    const allowMethods = r.headers.get('access-control-allow-methods') ?? '';
    expect(allowMethods).toMatch(/GET/);
    expect(allowMethods).toMatch(/POST/);
    expect(allowMethods).toMatch(/DELETE/);
    expect(allowMethods).toMatch(/OPTIONS/);
    const allowHeaders = r.headers.get('access-control-allow-headers') ?? '';
    expect(allowHeaders).toMatch(/Authorization/i);
    expect(allowHeaders).toMatch(/Content-Type/i);
    expect(r.headers.get('vary')).toContain('Origin');
    // PNA header NOT advertised when the request didn't ask for it.
    expect(r.headers.get('access-control-allow-private-network')).toBeNull();
  });
});

describe('S2 #702 — Chrome PNA preflight echo', () => {
  it('OPTIONS with Access-Control-Request-Private-Network: true echoes Allow-Private-Network: true', async () => {
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ccsm-worker.jiahuigu.workers.dev',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type',
        'Access-Control-Request-Private-Network': 'true',
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-private-network')).toBe('true');
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ccsm-worker.jiahuigu.workers.dev');
  });

  it('OPTIONS WITHOUT the PNA request header does NOT advertise Allow-Private-Network', async () => {
    // Don't volunteer PNA capability to peers that didn't ask for it.
    const r = await fetch(`${baseUrl}/api/sessions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://ccsm-worker.jiahuigu.workers.dev',
        'Access-Control-Request-Method': 'POST',
      },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-private-network')).toBeNull();
    // Other preflight headers still intact.
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ccsm-worker.jiahuigu.workers.dev');
    expect(r.headers.get('access-control-allow-methods')).toMatch(/POST/);
  });
});

// S2 #721 / T8 — opt-in `*.ccsm-worker.jiahuigu.workers.dev` preview subdomain allow-list.
// Default OFF: PR-preview subdomains are rejected (already covered above).
// When `CCSM_ALLOW_PAGES_PREVIEWS=1` is set, single-label https preview
// subdomains are accepted; spoof / multi-label / http variants stay rejected.
describe('S2 #721 / T8 — CCSM_ALLOW_PAGES_PREVIEWS opt-in', () => {
  const ENV_KEY = 'CCSM_ALLOW_PAGES_PREVIEWS';
  let savedEnv: string | undefined;

  beforeEach(() => {
    savedEnv = process.env[ENV_KEY];
  });

  afterEach(() => {
    if (savedEnv === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = savedEnv;
  });

  it('default (env unset): preview subdomain rejected', () => {
    delete process.env[ENV_KEY];
    expect(classifyOrigin('https://abc123-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('CCSM_ALLOW_PAGES_PREVIEWS=0: preview subdomain still rejected', () => {
    process.env[ENV_KEY] = '0';
    expect(classifyOrigin('https://abc123-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('CCSM_ALLOW_PAGES_PREVIEWS=1: single-label https preview accepted', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://abc123-ccsm-worker.jiahuigu.workers.dev')).toBe('allowed');
    expect(classifyOrigin('https://deploy-preview-42-ccsm-worker.jiahuigu.workers.dev')).toBe('allowed');
  });

  it('opt-in: prod host still allowed (regression)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://ccsm-worker.jiahuigu.workers.dev')).toBe('allowed');
  });

  it('opt-in: http preview rejected (must be https)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('http://abc123-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('opt-in: multi-label preview rejected (only single label allowed)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://a.b-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('opt-in: sibling spoof still rejected (ccsm-worker-evil.jiahuigu.workers.dev)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://ccsm-worker-evil.jiahuigu.workers.dev')).toBe('rejected');
    expect(classifyOrigin('https://x-ccsm-worker-evil.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('opt-in: suffix spoof still rejected (ccsm-worker.jiahuigu.workers.dev.attacker.com)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://abc-ccsm-worker.jiahuigu.workers.dev.attacker.com')).toBe('rejected');
  });

  it('opt-in: empty / dotted label rejected (defensive)', () => {
    process.env[ENV_KEY] = '1';
    // `.ccsm-worker.jiahuigu.workers.dev` parses to host `ccsm-worker.jiahuigu.workers.dev` (the prod host) so
    // is handled by the exact-match branch; the empty-label form below would
    // only arise via crafted hostnames and must not become "allowed".
    expect(classifyOrigin('https://_-ccsm-worker.jiahuigu.workers.dev')).toBe('rejected');
  });

  it('opt-in does not loosen unrelated origins (evil.com still rejected)', () => {
    process.env[ENV_KEY] = '1';
    expect(classifyOrigin('https://evil.com')).toBe('rejected');
    expect(classifyOrigin('http://evil.com')).toBe('rejected');
  });
});
