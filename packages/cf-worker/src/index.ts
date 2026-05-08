export interface Env {
  TUNNEL: DurableObjectNamespace;
}

export { TunnelDO } from './tunnel-do';

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const isUpgrade =
      req.headers.get('Upgrade')?.toLowerCase() === 'websocket';

    if (
      (url.pathname === '/ws/default' || url.pathname === '/tunnel/default') &&
      isUpgrade
    ) {
      // Route both directions into the same DO instance keyed by 'default'
      // so the daemon ws and browser ws end up paired in one TunnelDO.
      // Multi-tunnel routing (per-user / per-pairing-id) is future work.
      const id = env.TUNNEL.idFromName('default');
      const stub = env.TUNNEL.get(id);
      // Task #782 (S3-T6): forward the full request (incl.
      // `Sec-WebSocket-Protocol` if the browser sent one) to the DO. The DO
      // is responsible for echoing the protocol back on the 101 response so
      // the browser doesn't reject the handshake (RFC 6455 §4.2.2 step 4).
      return stub.fetch(req);
    }
    return new Response('Not Found', { status: 404 });
  },
};
