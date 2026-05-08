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
      envThatExplodesOnTunnelAccess(),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok\n');
  });

  it('still 404s for unknown paths (does not become a permissive proxy)', async () => {
    // Intentionally pass a real-ish env where TUNNEL access does NOT throw,
    // so we hit the existing 404 branch without false positives.
    const res = await worker.fetch(
      new Request('http://127.0.0.1:8787/totally-unknown'),
      { TUNNEL: undefined as unknown as DurableObjectNamespace },
    );
    expect(res.status).toBe(404);
  });
});
