/**
 * Daemon entrypoint.
 *
 * Protocol contract with the Electron host process:
 *  - The very first line on stdout is `PORT=<n>\n` where <n> is the bound port.
 *  - All other operational logging goes to stderr (stdout is reserved for the
 *    PORT line so the host can parse it without ambiguity).
 *  - On SIGTERM / SIGINT the daemon closes the HTTP server gracefully and
 *    exits 0.
 *
 * Wave-1 endpoints: GET /api/health, GET /api/version. Wave-2+ endpoints are
 * registered via daemon/api/index.ts → registerApi().
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { registerApi } from "./api/index";
import { startServer, type ServerHandle } from "./server";
import { Router, type HandlerResult } from "./router";
import { runStartup } from "./startup/index";

interface PackageJsonLike {
  version?: string;
  name?: string;
}

function readPackageVersion(): string {
  // dist/daemon/main.js → ../../package.json (rootDir is the repo root).
  const pkgPath = join(__dirname, "..", "..", "package.json");
  try {
    const raw = readFileSync(pkgPath, "utf8");
    const pkg = JSON.parse(raw) as PackageJsonLike;
    return pkg.version ?? "0.0.0";
  } catch (err) {
    process.stderr.write(
      `[daemon] failed to read package.json at ${pkgPath}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    return "0.0.0";
  }
}

function buildRouter(version: string): Router {
  const router = new Router();

  router.addRoute("GET", "/api/health", (): HandlerResult => {
    return { status: 200, body: { ok: true } };
  });

  router.addRoute("GET", "/api/version", (): HandlerResult => {
    return { status: 200, body: { version } };
  });

  registerApi(router);
  return router;
}

function installShutdown(handle: ServerHandle, abortController: AbortController): void {
  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stderr.write(`[daemon] received ${signal}, shutting down\n`);
    abortController.abort();
    // Stop accepting new connections; existing keep-alive conns will be torn
    // down by Node when there is no in-flight request.
    handle.close().then(
      () => {
        process.stderr.write("[daemon] server closed cleanly\n");
        process.exit(0);
      },
      (err: unknown) => {
        process.stderr.write(
          `[daemon] error during close: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exit(1);
      },
    );
    // Belt-and-suspenders: if close() hangs on lingering keep-alive sockets,
    // force-exit after a short grace window so the host process is never stuck.
    setTimeout(() => {
      process.stderr.write("[daemon] forced exit after shutdown timeout\n");
      process.exit(0);
    }, 5_000).unref();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
}

async function main(): Promise<void> {
  const version = readPackageVersion();
  const router = buildRouter(version);
  const abortController = new AbortController();

  await runStartup({ router, version, abort: abortController.signal });

  const handle = await startServer({ router });

  // PROTOCOL: first line on stdout MUST be `PORT=<n>\n`. Don't add prefix,
  // don't buffer, don't conflate with logs.
  process.stdout.write(`PORT=${handle.port}\n`);

  installShutdown(handle, abortController);

  process.stderr.write(
    `[daemon] listening on 127.0.0.1:${handle.port} (version=${version})\n`,
  );
}

main().catch((err: unknown) => {
  process.stderr.write(
    `[daemon] fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}\n`,
  );
  process.exit(1);
});
