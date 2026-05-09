// R-15 (Task #37) — `/health` is a binding-free liveness probe used by the
// smoke orchestrator's stage 1 stable-readiness check. dev-36 verify saw
// `UND_ERR_HEADERS_TIMEOUT` on bare `GET /` because `/` was routed into
// TunnelDO and workerd did not flush headers during cold-start. `/health`
// must short-circuit before any DO touch and return a static 200 / 'ok\n'.
//
// We import the worker's default export and call `.fetch(req, env)` directly
// with a stub `env` whose TUNNEL access throws — that proves /health does
// not look at the binding (regression guard against someone reordering the
// branches).
import { describe, it, expect } from 'vitest';
import worker from '../src/index';

function envThatExplodesOnTunnelAccess(): { TUNNEL: DurableObjectNamespace } {
  return new Proxy({} as { TUNNEL: DurableObjectNamespace }, {
    get(_t, prop) {
      if (prop === 'TUNNEL') {
        throw new Error('regression: /health must not touch env.TUNNEL');
      }
      return undefined;
    },
  });
}

describe('cf-worker /health', () => {
  it('returns 200 ok without touching any binding', async () => {
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/health'),
      envThatExplodesOnTunnelAccess() as unknown as Parameters<typeof worker.fetch>[1],
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok\n');
  });

  it('catch-all defers to Workers Static Assets (SPA fallback)', async () => {
    // Task #154 (R-49 audit P1, F-A-2): unknown paths no longer return a
    // hard 404 from the Worker. With `[assets] not_found_handling =
    // "single-page-application"` configured in wrangler.toml, the catch-all
    // forwards to env.ASSETS so the asset server can serve the SPA shell
    // (or a real static asset, if the path happens to match one).
    //
    // We stub ASSETS as a Fetcher that records the request and returns a
    // sentinel response. The Worker must call ASSETS.fetch and return its
    // response unchanged.
    let assetsHits = 0;
    let lastUrl = '';
    const sentinel = new Response('SPA SHELL', {
      status: 200,
      headers: { 'content-type': 'text/html' },
    });
    const env = {
      TUNNEL: undefined as unknown as DurableObjectNamespace,
      ASSETS: {
        fetch(req: Request | string | URL): Response | Promise<Response> {
          assetsHits++;
          lastUrl = typeof req === 'string' ? req : (req as Request).url;
          return sentinel;
        },
      },
    } as unknown as Parameters<typeof worker.fetch>[1];
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/totally-unknown'),
      env,
    );
    expect(assetsHits).toBe(1);
    expect(lastUrl).toContain('/totally-unknown');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('SPA SHELL');
  });
});
