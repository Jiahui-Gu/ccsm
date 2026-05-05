/**
 * Simple method+path → handler router for daemon HTTP server.
 *
 * Wave-1 skeleton: only exact-match routes (no params, no wildcards).
 * Wave-2 deciders/sinks add routes via addRoute(); see daemon/api/index.ts.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export type HandlerResult =
  | { status: 200; body: unknown }
  | { status: 400; error: string }
  | { status: 404; error: string }
  | { status: 500; error: string };

export type Handler = (
  req: IncomingMessage,
  body: unknown,
) => HandlerResult | Promise<HandlerResult>;

export interface Route {
  method: string;
  path: string;
  handler: Handler;
}

export class Router {
  private readonly routes = new Map<string, Handler>();

  addRoute(method: string, path: string, handler: Handler): void {
    const key = this.key(method, path);
    if (this.routes.has(key)) {
      throw new Error(`Route already registered: ${key}`);
    }
    this.routes.set(key, handler);
  }

  resolve(method: string, path: string): Handler | undefined {
    return this.routes.get(this.key(method, path));
  }

  private key(method: string, path: string): string {
    return `${method.toUpperCase()} ${path}`;
  }
}

/** Write a HandlerResult to a ServerResponse with `application/json`. */
export function writeJson(res: ServerResponse, result: HandlerResult): void {
  res.statusCode = result.status;
  res.setHeader("Content-Type", "application/json");
  const payload =
    result.status === 200
      ? JSON.stringify(result.body)
      : JSON.stringify({ error: result.error });
  res.end(payload);
}
