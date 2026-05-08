export interface Env {
  TUNNEL: DurableObjectNamespace;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    // env is reserved for T2 routing into the TUNNEL Durable Object.
    void env;

    const url = new URL(req.url);
    const isUpgrade =
      req.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (
      (url.pathname === '/ws/default' || url.pathname === '/tunnel/default') &&
      isUpgrade
    ) {
      // T2 will route to DO. T1 placeholder: 426 Upgrade Required.
      return new Response('Tunnel handler not yet wired (S3-T2 pending)', {
        status: 426,
      });
    }
    return new Response('Not Found', { status: 404 });
  },
};

// TunnelDO is implemented in S3-T2 (tunnel-do.ts). Stub class so wrangler.toml
// binding resolves and `wrangler dev` boots without a missing-class error.
export class TunnelDO {
  constructor(state: DurableObjectState, env: Env) {
    void state;
    void env;
  }
  async fetch(req: Request): Promise<Response> {
    void req;
    return new Response('TunnelDO stub (S3-T2 pending)', { status: 501 });
  }
}
