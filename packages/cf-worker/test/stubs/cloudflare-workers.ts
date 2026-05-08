/**
 * Test-only stub for the `cloudflare:workers` virtual module. The runtime
 * provides this module in production; vitest cannot resolve it under Node.
 * We export a minimal `DurableObject` base class with the same shape the
 * test mocks rely on (constructor stores ctx/env, no-op default methods).
 */
export class DurableObject<Env = unknown> {
  protected ctx: DurableObjectState;
  protected env: Env;
  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
  // Default no-op overridable lifecycle hooks. Subclasses override these.
  fetch(_req: Request): Response | Promise<Response> {
    return new Response('not implemented', { status: 500 });
  }
  webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): void {
    /* no-op */
  }
  webSocketClose(_ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    /* no-op */
  }
  webSocketError(_ws: WebSocket, _err: unknown): void {
    /* no-op */
  }
}
