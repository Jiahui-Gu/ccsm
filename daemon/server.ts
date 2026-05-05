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
 *
 * --------------------------------------------------------------------------
 * SECURITY INVARIANT — LOOPBACK ONLY (spec: 2026-05-06 v0.3 e2e cutover §3)
 * --------------------------------------------------------------------------
 * The daemon HTTP server MUST bind to a loopback interface (127.0.0.1 or
 * ::1). Binding to 0.0.0.0, a public IP, or a hostname that resolves to a
 * non-loopback interface would expose the daemon's command/control surface
 * to the local network — every endpoint here can read/spawn arbitrary user
 * sessions, mutate prefs, and stream pty traffic. There is no auth layer
 * (the daemon trusts the loopback boundary). DO NOT relax this without a
 * spec change AND an auth story.
 *
 * Enforcement is two-layered, both fail-closed:
 *   1. `assertLoopbackHost(host)` rejects non-loopback string inputs before
 *      `server.listen()` is called.
 *   2. After listen, we re-check `server.address().address` to catch the
 *      case where DNS resolved a "loopback-looking" hostname to an
 *      external interface (or a future Node release changes semantics).
 *
 * If either check fails, we close the socket and throw — the daemon will
 * not start. This is deliberately louder than logging a warning.
 */

import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { isIP, type AddressInfo } from "node:net";

import { Router, writeJson, type HandlerResult } from "./router";

const MAX_BODY_BYTES = 1 * 1024 * 1024; // 1 MiB; wave-1 endpoints are tiny.

/**
 * Allow-list of loopback host strings accepted by `startServer`.
 *
 * Intentionally narrow: only the canonical IPv4 / IPv6 loopback literals.
 * "localhost" is NOT included — on misconfigured hosts it can resolve to
 * a non-loopback address (corp DNS, /etc/hosts overrides, search domains).
 * Callers that need a hostname should resolve it themselves and pass the
 * literal IP, so the loopback check is unambiguous.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["127.0.0.1", "::1"]);

/**
 * Returns true if `addr` is a loopback IP literal.
 *
 * Accepts:
 *  - any 127.0.0.0/8 IPv4 address (Node's `server.address()` may report
 *    `127.0.0.1` or, on some platforms, the equivalent dotted form).
 *  - `::1` and its full form `0:0:0:0:0:0:0:1`.
 *  - IPv4-mapped IPv6 loopback `::ffff:127.0.0.1` (Node sometimes reports
 *    this when the OS dual-stacks an IPv4 listen).
 */
function isLoopbackAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    return addr.startsWith("127.");
  }
  if (family === 6) {
    if (addr === "::1" || addr === "0:0:0:0:0:0:0:1") return true;
    // IPv4-mapped IPv6: ::ffff:127.x.x.x
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(addr);
    if (mapped && mapped[1].startsWith("127.")) return true;
    return false;
  }
  return false;
}

/**
 * Throws if `host` is not in the loopback allow-list. Fails closed.
 *
 * See SECURITY INVARIANT note above. The error message is intentionally
 * explicit — if this fires in production, an operator needs to know
 * exactly what was rejected and why.
 */
export function assertLoopbackHost(host: string): void {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(
      `daemon: refusing to bind non-loopback host "${host}" — daemon HTTP ` +
        `server must bind 127.0.0.1 or ::1 (no auth layer; loopback is the ` +
        `trust boundary). Allowed: ${[...LOOPBACK_HOSTS].join(", ")}.`,
    );
  }
}

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

  // Pre-listen guard: reject non-loopback host strings before opening
  // any socket. See SECURITY INVARIANT in the file header.
  assertLoopbackHost(host);

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

  // Post-listen guard: belt-and-braces re-check that the kernel actually
  // bound a loopback interface. Catches the case where DNS / OS quirks
  // resolved a "loopback-looking" host to something external. If this
  // fires, close the socket so we don't leak a public listener.
  if (!isLoopbackAddress(addr.address)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      `daemon: server bound non-loopback address "${addr.address}" — ` +
        `aborting (loopback invariant).`,
    );
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
