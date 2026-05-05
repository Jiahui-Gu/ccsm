/**
 * Daemon HTTP server factory.
 *
 * Listens on 127.0.0.1:0 (random port). Exposes a handle that lets the caller
 * read the bound port and perform a graceful shutdown.
 *
 * Wire protocol contract (see daemon/main.ts):
 *  - All responses are `application/json`.
 *  - 200 OK / 400 bad_request / 404 not_found / 500 internal_error.
 *  - Request bodies, when present, are `application/json`.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

import { Router, writeJson, type HandlerResult } from "./router";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB; wave-1 endpoints are tiny.

export interface ServerHandle {
  server: Server;
  port: number;
  router: Router;
  close: () => Promise<void>;
}

export interface CreateServerOptions {
  router: Router;
  host?: string;
  port?: number;
}

export async function startServer(
  opts: CreateServerOptions,
): Promise<ServerHandle> {
  const { router } = opts;
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 0;

  const server = createServer((req, res) => {
    void handleRequest(router, req, res);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener("listening", onListen);
      reject(err);
    };
    const onListen = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListen);
    server.listen(port, host);
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === "string") {
    throw new Error("daemon: failed to bind server (no AddressInfo)");
  }

  const close = (): Promise<void> =>
    new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

  return { server, port: addr.port, router, close };
}

async function handleRequest(
  router: Router,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    // Strip query string; wave-1 endpoints don't read it. (Raw handlers
    // get the unmodified `req.url` and may parse the query themselves —
    // W2-B `/api/events/pty?sid=...` does this.)
    const path = url.split("?", 1)[0] ?? "/";

    // Raw streaming handlers (SSE / chunked / non-JSON) take precedence.
    // The handler owns the response end-to-end; the pipeline neither
    // reads the body nor writes a status.
    const rawHandler = router.resolveRaw(method, path);
    if (rawHandler) {
      try {
        await rawHandler(req, res);
      } catch (err) {
        process.stderr.write(
          `[daemon] raw handler threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
        );
        if (!res.headersSent) {
          writeJson(res, { status: 500, error: "internal_error" });
        } else {
          try { res.end(); } catch { /* socket gone */ }
        }
      }
      return;
    }

    const handler = router.resolve(method, path);
    if (!handler) {
      writeJson(res, { status: 404, error: "not_found" });
      return;
    }

    let body: unknown = undefined;
    if (method !== "GET" && method !== "HEAD") {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        writeJson(res, { status: 400, error: parsed.error });
        return;
      }
      body = parsed.value;
    }

    let result: HandlerResult;
    try {
      result = await handler(req, body, res);
    } catch (err) {
      process.stderr.write(
        `[daemon] handler threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
      );
      writeJson(res, { status: 500, error: "internal_error" });
      return;
    }
    writeJson(res, result);
  } catch (err) {
    process.stderr.write(
      `[daemon] request pipeline error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    if (!res.headersSent) {
      writeJson(res, { status: 500, error: "internal_error" });
    } else {
      res.end();
    }
  }
}

type ParseResult =
  | { ok: true; value: unknown }
  | { ok: false; error: string };

async function readJsonBody(req: IncomingMessage): Promise<ParseResult> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_BODY_BYTES) {
      return { ok: false, error: "body_too_large" };
    }
    chunks.push(buf);
  }
  if (total === 0) {
    return { ok: true, value: undefined };
  }
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false, error: "invalid_json" };
  }
}
