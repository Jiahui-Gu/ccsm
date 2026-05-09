// Task #154 (R-49 audit P1, F-A-2): SPA static-asset fallback semantics
// after folding the cc-sm Pages Function into this Worker.
//
// Two invariants this file pins down:
//
//   1. SPA history-mode unknown routes (e.g. `/sessions/123`) reach the
//      Worker's catch-all and are forwarded to `env.ASSETS.fetch(req)`,
//      where the wrangler.toml `not_found_handling =
//      "single-page-application"` config rewrites to `index.html`.
//
//   2. R-44 (Task #152) browser auth endpoints — `/api/auth/me` and
//      `/api/auth/ws-ticket` — are NOT fallthrough-eligible: they must
//      reach the auth dispatch chain (`dispatchDevice` → `dispatchAuth`)
//      and, if both return null (e.g. wrong method), return a hard 404
//      from the `/api/auth/` branch instead of being silently rewritten
//      to the SPA shell. Otherwise a misrouted /api/auth/* request would
//      return HTML to a fetch() call expecting JSON, which would surface
//      as a confusing parse error in the SPA.
//
// The fixture stubs out ASSETS as a counting Fetcher and asserts whether
// or not it was invoked for each scenario.

import { describe, it, expect } from 'vitest';
import worker from '../src/index';

interface AssetsCallRecord {
  hits: number;
  lastUrl: string;
}

function makeEnv(): { env: Parameters<typeof worker.fetch>[1]; assets: AssetsCallRecord } {
  const assets: AssetsCallRecord = { hits: 0, lastUrl: '' };
  const env = {
    TUNNEL: undefined as unknown as DurableObjectNamespace,
    USER_DO: undefined as unknown as DurableObjectNamespace,
    GITHUB_OAUTH_CLIENT_ID: '',
    GITHUB_OAUTH_CLIENT_SECRET: '',
    JWT_SIGNING_KEY: '',
    JWT_REFRESH_SIGNING_KEY: '',
    ASSETS: {
      fetch(req: Request | string | URL): Response | Promise<Response> {
        assets.hits++;
        assets.lastUrl = typeof req === 'string' ? req : (req as Request).url;
        return new Response('<!doctype html><html><body>SPA</body></html>', {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      },
    },
  } as unknown as Parameters<typeof worker.fetch>[1];
  return { env, assets };
}

describe('cf-worker SPA fallback (Task #154)', () => {
  it('rewrites unknown SPA history routes via env.ASSETS', async () => {
    const { env, assets } = makeEnv();
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/sessions/abc-123'),
      env,
    );
    expect(assets.hits).toBe(1);
    expect(assets.lastUrl).toContain('/sessions/abc-123');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type') ?? '').toContain('text/html');
  });

  it('rewrites the bare root via env.ASSETS so index.html is served', async () => {
    const { env, assets } = makeEnv();
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/'),
      env,
    );
    expect(assets.hits).toBe(1);
    expect(res.status).toBe(200);
  });

  it('does NOT fall back to ASSETS for /api/auth/me with an unsupported method', async () => {
    // POST /api/auth/me is not part of dispatchAuth (only GET is). The auth
    // dispatch chain returns null, the `/api/auth/` branch then returns a
    // hard 404. Crucially, the request must NOT be forwarded to ASSETS —
    // returning HTML to a fetch() expecting JSON would mask the bug.
    const { env, assets } = makeEnv();
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/auth/me', { method: 'POST' }),
      env,
    );
    expect(assets.hits).toBe(0);
    expect(res.status).toBe(404);
    // And explicitly not HTML — we want a plain-text 404 body the SPA can
    // distinguish from a successful asset response.
    const ct = res.headers.get('content-type') ?? '';
    expect(ct.includes('text/html')).toBe(false);
  });

  it('does NOT fall back to ASSETS for /api/auth/ws-ticket (R-44 endpoint) with an unsupported method', async () => {
    const { env, assets } = makeEnv();
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/auth/ws-ticket', { method: 'PUT' }),
      env,
    );
    expect(assets.hits).toBe(0);
    expect(res.status).toBe(404);
    const ct = res.headers.get('content-type') ?? '';
    expect(ct.includes('text/html')).toBe(false);
  });

  it('does NOT fall back to ASSETS for an unknown /api/auth/* sub-path', async () => {
    // /api/auth/<unknown> must die in the /api/auth/ branch (404), not be
    // rewritten to the SPA shell. This is the strongest form of the R-44
    // invariant: even GETs under /api/auth/ that the auth dispatcher does
    // not own must NOT leak into the static-asset path.
    const { env, assets } = makeEnv();
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/api/auth/totally-unknown'),
      env,
    );
    expect(assets.hits).toBe(0);
    expect(res.status).toBe(404);
  });
});
