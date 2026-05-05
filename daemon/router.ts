/**
 * Simple method+path → handler router for daemon HTTP server.
 *
 * Wave-1 skeleton: only exact-match routes (no params, no wildcards).
 * Wave-2 deciders/sinks add routes via addRoute(); see daemon/api/index.ts.
 *
 * W2-B (Task #581) extension: streaming endpoints (server-sent events for
 * pty:data / pty:exit / pty:ack) need direct access to `ServerResponse` to
 * push chunks over time, which the json-oneshot `Handler` type cannot
 * express. `RawHandler` + `addRawRoute` keep the existing JSON contract
 * untouched while exposing a non-buffered escape hatch for SSE-style
 * streams. The server.ts pipeline checks the raw routes first; raw handlers
 * own the response (status + headers + body) end-to-end.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type HandlerResult =
  | { status: 200; body: unknown }
  | { status: 400; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string }
  // Wave-2-C: handler took ownership of the response (SSE / long-poll). The
  // server pipeline must NOT call writeJson again on this code-path. Handler
  // is responsible for writeHead, body writes, and end().
  | { status: 0; streamed: true };

export type Handler = (
  req: IncomingMessage,
  body: unknown,
  res: ServerResponse,
) => HandlerResult | Promise<HandlerResult>;

/** Raw handler — owns the entire response (status / headers / body). Used
 *  for SSE / chunked / non-JSON endpoints (W2-B `/api/events/pty`). The
 *  server pipeline does NOT read the request body for raw routes; the
 *  handler is responsible for its own body parsing if it needs one. */
export type RawHandler = (
  req: IncomingMessage,
  res: ServerResponse,
) => void | Promise<void>;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export class Router {
  private readonly routes = new Map<string, Handler>();
  private readonly rawRoutes = new Map<string, RawHandler>();

  addRoute(method: string, path: string, handler: Handler): void {
    const key = this.key(method, path);
    if (this.routes.has(key) || this.rawRoutes.has(key)) {
      throw new Error(`Route already registered: ${key}`);
    }
    this.routes.set(key, handler);
  }

  /** Register a raw streaming handler. Same uniqueness rules as `addRoute`
   *  — a raw + json route on the same method+path conflicts. */
  addRawRoute(method: string, path: string, handler: RawHandler): void {
    const key = this.key(method, path);
    if (this.routes.has(key) || this.rawRoutes.has(key)) {
      throw new Error(`Route already registered: ${key}`);
    }
    this.rawRoutes.set(key, handler);
  }

  resolve(method: string, path: string): Handler | undefined {
    return this.routes.get(this.key(method, path));
  }

  resolveRaw(method: string, path: string): RawHandler | undefined {
    return this.rawRoutes.get(this.key(method, path));
  }

  private key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }
}

/** Write a HandlerResult to a ServerResponse with `application/json`.
 *  Streamed results are skipped — the handler already owns the response. */
export function writeJson(res: ServerResponse, result: HandlerResult): void {
  if (result.status === 0) return; // streamed: handler wrote it.
  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  const payload =
    result.status === 200
      ? JSON.stringify(result.body)
      : JSON.stringify({ error: result.error });
  res.end(payload);
}
