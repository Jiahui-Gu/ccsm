// T6.1 — Electron main: descriptor server via `protocol.handle('app', ...)`.
//
// Spec ref: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
// chapter 08 §4.1 (locked: descriptor served via `protocol.handle`, no
// `contextBridge`). Sequence:
//
//   1. Electron main reads `listener-a.json` from the locked per-OS path
//      (chapter 07 §2 / chapter 03 §3).
//   2. Electron main rewrites the descriptor's `address` field to point at
//      the bridge's loopback endpoint (§4.2) — the renderer never sees the
//      daemon's UDS / named-pipe path.
//   3. Electron main registers a custom scheme handler via
//      `protocol.handle("app", ...)` that serves the rewritten descriptor at
//      `app://ccsm/listener-descriptor.json` (read-only;
//      `Content-Type: application/json`).
//   4. Renderer at boot calls `await fetch("app://ccsm/listener-descriptor.json")`
//      and parses the result. No `contextBridge`, no `additionalArguments`,
//      no preload-injected globals — `lint:no-ipc` (§5h.1) passes
//      mechanically.
//
// Scope of this file (T6.1):
//   - The pure pieces (descriptor path, address rewrite, request handler).
//   - A thin registration helper that calls `protocol.handle('app', handler)`
//     against a caller-supplied `protocol` object (dependency-injected so
//     unit tests do not need to spin up `electron`).
//   - A `registerAppSchemeAsPrivileged` helper for callers to invoke before
//     `app.whenReady()` (so renderer `fetch()` against `app://` is allowed
//     by Chromium's secure-context / CSP machinery).
//
// Out of scope (deferred to other tasks):
//   - The bridge endpoint itself: T6.2 (transport-bridge.ts §4.2). This
//     module accepts the bridge URL as a string; the bridge owner passes it
//     in. The default `'__BRIDGE_PENDING__'` sentinel is rejected at
//     handler-creation time so we cannot ship without a real wire.
//   - `index.ts` boot wiring: T6.6 stitches reads, the bridge, the
//     descriptor handler, and the tray menu together.
//
// Cross-package boundary discipline:
//   The eslint rule in `packages/electron/eslint.config.js` forbids
//   `import ... from '@ccsm/daemon'`. We therefore COPY the minimal slice
//   of `statePaths()` (just the per-OS root + `listener-a.json` join) here.
//   The reference implementation lives in
//   `packages/daemon/src/state-dir/paths.ts`; if either copy diverges the
//   `descriptorPath` unit tests below will catch the win32 / darwin /
//   linux cases against the same string fixtures the daemon spec uses.

import { readFile } from 'node:fs/promises';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Per-OS descriptor path — minimal slice copied from
// packages/daemon/src/state-dir/paths.ts (chapter 07 §2 table). The eslint
// rule `no-restricted-imports` (electron/eslint.config.js) forbids importing
// `@ccsm/daemon` so we cannot share the exported helper directly. Tests
// below assert the same string fixtures the daemon spec uses, so a future
// drift between the two copies will be caught at CI time.
// ---------------------------------------------------------------------------

/** NodeJS platform identifier; matches the daemon helper's signature. */
export type StateDirPlatform = NodeJS.Platform;

/**
 * Compute the absolute path to `listener-a.json` for a given platform + env
 * snapshot. Pure: no filesystem I/O, no implicit `process.env` reads.
 *
 * Spec ch07 §2 table:
 *   - win32:  `%PROGRAMDATA%\ccsm\listener-a.json`
 *             (fallback `C:\ProgramData\ccsm\listener-a.json`)
 *   - darwin: `/Library/Application Support/ccsm/listener-a.json`
 *   - linux/other: `/var/lib/ccsm/listener-a.json`
 */
export function descriptorPath(
  platform: StateDirPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (platform === 'win32') {
    const programData =
      env.PROGRAMDATA && env.PROGRAMDATA.length > 0
        ? env.PROGRAMDATA
        : 'C:\\ProgramData';
    return path.win32.join(programData, 'ccsm', 'listener-a.json');
  }
  if (platform === 'darwin') {
    return '/Library/Application Support/ccsm/listener-a.json';
  }
  // linux + every other POSIX. FHS-correct; do NOT respect XDG_DATA_HOME
  // here — see ch07 §2 ("the daemon may run with no logged-in user").
  return '/var/lib/ccsm/listener-a.json';
}

// ---------------------------------------------------------------------------
// Descriptor schema (renderer-facing slice of DescriptorV1).
//
// The daemon-side type is `packages/daemon/src/listeners/descriptor.ts`
// `DescriptorV1`. We re-declare the structural shape here so the boundary
// rule (electron MUST NOT import @ccsm/daemon) is honoured. Only the fields
// this module actually inspects/rewrites are typed strictly; the rest are
// passed through opaquely so a future v0.4 daemon adding a new top-level
// optional field (per ch15 §3 forbidden-pattern 8) does not require a code
// change here.
// ---------------------------------------------------------------------------

/** Closed enum of supported transports — copy of the daemon's enum. */
export type DescriptorTransport =
  | 'KIND_UDS'
  | 'KIND_NAMED_PIPE'
  | 'KIND_TCP_LOOPBACK_H2C'
  | 'KIND_TCP_LOOPBACK_H2_TLS';

/**
 * Renderer-facing descriptor shape. Mirrors `DescriptorV1` from
 * `packages/daemon/src/listeners/descriptor.ts`. We keep the snake_case
 * spelling intentional — it matches the on-disk JSON byte-for-byte so a
 * reverse-grep from `listener-a.json` to this type stays one hop.
 */
export interface DescriptorV1 {
  readonly version: 1;
  readonly transport: DescriptorTransport;
  readonly address: string;
  readonly tlsCertFingerprintSha256: string | null;
  readonly supervisorAddress: string;
  readonly boot_id: string;
  readonly daemon_pid: number;
  readonly listener_addr: string;
  readonly protocol_version: 1;
  readonly bind_unix_ms: number;
}

/** URL the renderer fetches. Spec ch08 §4.1 step 3 — locked. */
export const DESCRIPTOR_URL = 'app://ccsm/listener-descriptor.json' as const;

/** Custom scheme name registered against `protocol.handle`. */
export const APP_SCHEME = 'app' as const;

/** Sentinel used by callers that have not yet wired the bridge endpoint. */
export const BRIDGE_PENDING_SENTINEL = '__BRIDGE_PENDING__' as const;

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Parse + structurally validate the on-disk JSON. Throws on malformed JSON,
 * wrong `version`, or missing required fields. We deliberately do NOT
 * validate every field exhaustively — the daemon-side writer (T1.6) is the
 * authoritative producer; this is just enough to reject obviously corrupt
 * input so the renderer doesn't see `undefined.boot_id` later.
 *
 * The validator is exported so tests can assert each rejection branch
 * independently of disk I/O.
 */
export function parseDescriptor(json: string): DescriptorV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `descriptor JSON parse failed: ${(err as Error).message}`,
    );
  }
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('descriptor must be a JSON object');
  }
  const o = raw as Record<string, unknown>;
  if (o.version !== 1) {
    throw new Error(
      `descriptor version must be 1 (got ${JSON.stringify(o.version)}); ` +
        'v0.4+ schema additions ship as new top-level fields per ch03 §3.2',
    );
  }
  for (const key of [
    'transport',
    'address',
    'supervisorAddress',
    'boot_id',
    'listener_addr',
  ] as const) {
    if (typeof o[key] !== 'string' || (o[key] as string).length === 0) {
      throw new Error(`descriptor field "${key}" must be a non-empty string`);
    }
  }
  if (typeof o.daemon_pid !== 'number' || !Number.isFinite(o.daemon_pid)) {
    throw new Error('descriptor field "daemon_pid" must be a finite number');
  }
  if (o.protocol_version !== 1) {
    throw new Error('descriptor field "protocol_version" must be 1');
  }
  if (typeof o.bind_unix_ms !== 'number' || !Number.isFinite(o.bind_unix_ms)) {
    throw new Error('descriptor field "bind_unix_ms" must be a finite number');
  }
  if (
    o.tlsCertFingerprintSha256 !== null &&
    typeof o.tlsCertFingerprintSha256 !== 'string'
  ) {
    throw new Error(
      'descriptor field "tlsCertFingerprintSha256" must be a string or null',
    );
  }
  return raw as DescriptorV1;
}

/**
 * Rewrite the descriptor's `address` (and the duplicate `listener_addr`)
 * to point at the renderer-facing bridge endpoint. Per ch08 §4.1 step 2:
 * "the renderer never sees the daemon's UDS / named-pipe path because the
 * renderer never speaks to it directly".
 *
 * The original `transport` is preserved so future renderer tooling can log
 * the daemon's actual transport without speaking to it. We do NOT widen the
 * transport enum to a "bridge" pseudo-value — that would couple the
 * descriptor schema to the bridge impl, which the spec forbids.
 */
export function rewriteDescriptorAddress(
  descriptor: DescriptorV1,
  bridgeAddress: string,
): DescriptorV1 {
  if (bridgeAddress.length === 0) {
    throw new Error('bridgeAddress must be a non-empty string');
  }
  if (bridgeAddress === BRIDGE_PENDING_SENTINEL) {
    throw new Error(
      `refusing to serve descriptor with sentinel bridge address ` +
        `"${BRIDGE_PENDING_SENTINEL}"; T6.2 transport-bridge must wire a ` +
        'real loopback endpoint before T6.6 boot wiring',
    );
  }
  return {
    ...descriptor,
    address: bridgeAddress,
    listener_addr: bridgeAddress,
  };
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Async I/O surface the handler depends on. Injected so unit tests can
 * supply in-memory fakes without touching the filesystem and without
 * requiring `electron` itself.
 */
export interface DescriptorHandlerDeps {
  /**
   * Path the descriptor lives at (typically `descriptorPath()`). Exposed
   * so integration tests can point at a tmpdir descriptor.
   */
  readonly descriptorPath: string;
  /**
   * Loopback URL of the renderer transport bridge (§4.2). Replaces the
   * descriptor's `address` field before the response is served. T6.2 owns
   * the bridge implementation; T6.1 just rewrites.
   */
  readonly bridgeAddress: string;
  /** Override for tests; defaults to `node:fs/promises` `readFile`. */
  readonly readDescriptorFile?: (p: string) => Promise<string>;
}

/**
 * Build the request handler `protocol.handle('app', ...)` will dispatch to.
 *
 * Behaviour per ch08 §4.1:
 *   - Only `app://ccsm/listener-descriptor.json` is served. Any other path
 *     under the `app://` scheme returns 404. We do NOT fall back to file://
 *     or any other resource — this scheme is single-purpose in v0.3.
 *   - Method MUST be `GET` (or `HEAD`). Anything else returns 405.
 *   - Successful response body is the rewritten descriptor as JSON with
 *     `Content-Type: application/json` and `Cache-Control: no-store` (the
 *     descriptor changes every daemon boot — caching it is wrong).
 *   - Read errors map to 503 (descriptor not yet written / daemon down) so
 *     the renderer's retry loop has a clear signal.
 *   - Validation errors map to 500 (the on-disk file is corrupt; the
 *     daemon-side writer is broken — non-recoverable on the renderer side).
 *
 * The handler is a plain `(req: Request) => Promise<Response>`. It does not
 * import `electron` so it can be unit-tested with a synthetic `Request`.
 */
export function createDescriptorHandler(
  deps: DescriptorHandlerDeps,
): (req: Request) => Promise<Response> {
  // Eagerly assert the bridge sentinel was replaced so a misconfigured
  // boot fails at startup rather than serving a useless descriptor.
  if (deps.bridgeAddress === BRIDGE_PENDING_SENTINEL) {
    throw new Error(
      `createDescriptorHandler refuses sentinel bridge address ` +
        `"${BRIDGE_PENDING_SENTINEL}"`,
    );
  }
  if (deps.bridgeAddress.length === 0) {
    throw new Error('createDescriptorHandler requires a non-empty bridgeAddress');
  }
  const reader = deps.readDescriptorFile ?? defaultReadDescriptorFile;
  return async (req: Request): Promise<Response> => {
    // URL parse. Custom schemes are not in WHATWG's "special scheme" list
    // so `URL` treats them as opaque — `pathname` is still extractable.
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return jsonError(400, 'invalid request URL');
    }
    if (url.protocol !== `${APP_SCHEME}:`) {
      return jsonError(404, 'unknown scheme');
    }
    if (url.pathname !== '/listener-descriptor.json') {
      return jsonError(404, 'unknown app:// resource');
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return jsonError(405, `method ${req.method} not allowed`, {
        Allow: 'GET, HEAD',
      });
    }

    let raw: string;
    try {
      raw = await reader(deps.descriptorPath);
    } catch (err) {
      // ENOENT is the "daemon hasn't written the file yet" common case —
      // surface it as 503 so the renderer's bootstrap loop retries.
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        return jsonError(503, 'descriptor not yet available');
      }
      return jsonError(503, `descriptor read failed: ${(err as Error).message}`);
    }

    let parsed: DescriptorV1;
    try {
      parsed = parseDescriptor(raw);
    } catch (err) {
      return jsonError(500, `descriptor invalid: ${(err as Error).message}`);
    }

    const rewritten = rewriteDescriptorAddress(parsed, deps.bridgeAddress);
    const body = `${JSON.stringify(rewritten)}\n`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      // The descriptor is ephemeral per-boot; X-Content-Type-Options stops
      // the renderer's MIME sniffer from reinterpreting it.
      'X-Content-Type-Options': 'nosniff',
    };
    if (req.method === 'HEAD') {
      return new Response(null, { status: 200, headers });
    }
    return new Response(body, { status: 200, headers });
  };
}

function defaultReadDescriptorFile(p: string): Promise<string> {
  return readFile(p, 'utf8');
}

function jsonError(
  status: number,
  message: string,
  extraHeaders: Record<string, string> = {},
): Response {
  const body = `${JSON.stringify({ error: message })}\n`;
  return new Response(body, {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

// ---------------------------------------------------------------------------
// Electron registration helpers
// ---------------------------------------------------------------------------
//
// These two helpers wrap the `electron` API surface. They are kept tiny so
// the unit tests above can cover the behaviour without spawning Electron;
// the e2e gate (chapter 12 §4) exercises the full wire.
//
// We type the `protocol` / `scheme privileges` arguments structurally so
// this file does not need a static `import { protocol } from 'electron'`.
// The caller in T6.6 will pass the real Electron objects; tests pass fakes.

/** Minimal structural interface of Electron's `Protocol` for our use. */
export interface ElectronProtocolLike {
  handle(scheme: string, handler: (req: Request) => Promise<Response>): void;
  unhandle?: (scheme: string) => void;
}

/** Minimal structural interface of Electron's `protocol.registerSchemesAsPrivileged`. */
export interface ElectronSchemeRegistrarLike {
  registerSchemesAsPrivileged(
    customSchemes: Array<{
      scheme: string;
      privileges: {
        standard?: boolean;
        secure?: boolean;
        supportFetchAPI?: boolean;
        bypassCSP?: boolean;
        corsEnabled?: boolean;
        stream?: boolean;
      };
    }>,
  ): void;
}

/**
 * Privilege registration for the `app://` scheme. MUST be called before
 * `app.whenReady()` per Electron's API contract — the renderer cannot
 * `fetch()` a non-privileged custom scheme reliably.
 *
 * The privilege set is intentionally narrow:
 *   - `standard: true`      — needed for URL parsing + relative resolution.
 *   - `secure: true`        — Chromium treats the origin as secure context
 *                             so `fetch()` doesn't trip mixed-content.
 *   - `supportFetchAPI: true` — explicitly allow `fetch('app://...')` from
 *                             the renderer.
 *   - `corsEnabled: true`   — the renderer origin and the app:// origin
 *                             differ; CORS must succeed.
 *   - `stream: false` (default) — the descriptor is a tiny JSON blob.
 *   - `bypassCSP: false` (default) — the renderer's CSP still applies.
 */
export function registerAppSchemeAsPrivileged(
  registrar: ElectronSchemeRegistrarLike,
): void {
  registrar.registerSchemesAsPrivileged([
    {
      scheme: APP_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
      },
    },
  ]);
}

/** Inputs for `registerProtocolApp`. */
export interface RegisterProtocolAppOptions {
  readonly protocol: ElectronProtocolLike;
  readonly bridgeAddress: string;
  readonly descriptorPath?: string;
  readonly readDescriptorFile?: (p: string) => Promise<string>;
  readonly platform?: StateDirPlatform;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Register the `app://` scheme handler against an Electron `protocol`
 * object. MUST be called after `app.whenReady()`.
 *
 * Returns an `unregister()` callback for tests / hot-reload paths. The
 * Electron `protocol.unhandle` API is optional in older Electron versions;
 * we no-op if absent.
 */
export function registerProtocolApp(
  opts: RegisterProtocolAppOptions,
): () => void {
  const handler = createDescriptorHandler({
    descriptorPath:
      opts.descriptorPath ?? descriptorPath(opts.platform, opts.env),
    bridgeAddress: opts.bridgeAddress,
    readDescriptorFile: opts.readDescriptorFile,
  });
  opts.protocol.handle(APP_SCHEME, handler);
  return () => {
    opts.protocol.unhandle?.(APP_SCHEME);
  };
}
