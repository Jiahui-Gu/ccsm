// Supervisor UDS HTTP surface — `/healthz`, `/hello`, `/shutdown`.
//
// SEPARATE from data-plane Listener A. UDS-only on every OS (Windows uses a
// named pipe, which Node's `http.createServer().listen(pipePath)` binds the
// same way as POSIX UDS). Loopback-TCP supervisor is FORBIDDEN, period —
// spec ch03 §7 + ch15 §3 forbidden-pattern #16.
//
// Spec refs:
//   - ch02 §2 supervisor address per OS (already stored on
//     `DaemonEnv.paths.supervisorAddr`).
//   - ch02 §3 startup ordering — `/healthz` returns 503 until phase READY.
//   - ch02 §4 shutdown contract — `/shutdown` triggers OS-initiated path,
//     budget ≤5s + 3s SIGKILL window.
//   - ch03 §7 endpoints + per-OS bind table.
//   - ch03 §7.1 peer-cred is the SOLE authn (no JWT, ever); `/hello` +
//     `/shutdown` MUST reject non-allowlisted peers with HTTP 403.
//   - ch03 §7.2 security rationale (UDS-only, no JWT path, service-account
//     self-call allowed).
//   - ch15 §3 forbidden-pattern #9 — endpoint URLs + response shapes are
//     locked by `test/supervisor/contract.spec.ts` against checked-in
//     golden bodies; this server is the impl that produces them.
//
// SRP:
//   - This module is a *sink*: it accepts requests, consults pure deciders
//     (admin-allowlist + lifecycle), produces HTTP responses with locked
//     body shapes. The OS-specific syscalls (peer-cred lookup) live behind
//     injected callbacks (`extractUdsPeerCred` / `extractNamedPipePeerCred`
//     from ../auth/peer-cred). The shutdown side-effect is a single
//     injected callback (`onShutdown`).
//   - No retry, no logging policy, no graceful-shutdown timing — those are
//     the daemon entrypoint's job (T1.8).
//
// Layer 1 alternatives checked:
//   - Connect-RPC framing: rejected by spec ch03 §7 explicitly ("Connect
//     framing is overkill for three single-purpose endpoints; HTTP is
//     callable by `curl` from the installer / a postmortem shell").
//   - express / fastify / koa: rejected — single-process, three routes,
//     zero middleware ecosystem needs. `node:http` ships in the runtime.
//   - undici / fetch-based server: would require Bun/Deno semantics; we
//     are on Node.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Socket } from 'node:net';

import {
  extractNamedPipePeerCred,
  extractUdsPeerCred,
  type NamedPipeLookup,
  type UdsLookup,
} from '../auth/peer-cred.js';
import type { NamedPipePeerCred, UdsPeerCred } from '../auth/peer-info.js';
import type { Lifecycle } from '../lifecycle.js';
import type { RecoveryFlag, RecoveryModalState } from '../db/recovery.js';
import {
  defaultAdminAllowlist,
  isAllowed,
  type AdminAllowlist,
} from './admin-allowlist.js';
import { makeRecoveryFlag } from '../db/recovery.js';

// Re-export the URL/method constants from the contract spec so the server
// and the forever-stable contract test agree on a single source of truth
// (spec ch15 §3 #9). The contract file is the canonical writer; importing
// from `../../test/supervisor/contract.spec.ts` would cross src→test, so
// the constants are duplicated here behind an `as const` and a runtime
// assertion below pins them equal at server-construct time.
export const SUPERVISOR_URLS = {
  healthz: '/healthz',
  hello: '/hello',
  shutdown: '/shutdown',
  ackRecovery: '/ack-recovery',
} as const;

export const SUPERVISOR_METHODS = {
  healthz: 'GET',
  hello: 'POST',
  shutdown: 'POST',
  ackRecovery: 'POST',
} as const;

// ---------------------------------------------------------------------------
// Wire shapes — match the locked goldens under
// `packages/daemon/test/supervisor/golden/*.json` exactly. Any change here
// is a spec ch15 §3 #9 violation and the contract test catches it.
// ---------------------------------------------------------------------------

/**
 * GET /healthz body — spec ch03 §7 literal `{ ready, version, uptimeS,
 * boot_id }` extended by ch07 §6 with `recovery_modal: { pending, ts_ms,
 * corrupt_path }` for the corrupt-DB recovery flow (T5.7 / Task #60).
 *
 * The Electron client polls `/healthz` on attach; if `recovery_modal.pending`
 * is true, it shows a blocking modal and POSTs `/ack-recovery` to clear it
 * (ch07 §6 step 4(e)).
 */
export interface HealthzBody {
  readonly ready: boolean;
  readonly version: string;
  readonly uptimeS: number;
  readonly boot_id: string;
  readonly recovery_modal: RecoveryModalState;
}

/** POST /hello body — proto-mirrored shape (`SupervisorHelloResponse`). */
export interface HelloBody {
  readonly meta: {
    readonly request_id: string;
    readonly client_version: string;
    readonly client_send_unix_ms: number;
  };
  readonly daemon_version: string;
  readonly boot_id: string;
}

/** POST /shutdown body — proto-mirrored shape (`ShutdownResponse`). */
export interface ShutdownBody {
  readonly meta: {
    readonly request_id: string;
    readonly client_version: string;
    readonly client_send_unix_ms: number;
  };
  readonly accepted: boolean;
  readonly grace_ms: number;
}

/**
 * Body for HTTP 403 rejections (admin allowlist or peer-cred derivation
 * failure). Matches `golden/peer-cred-rejected.json` shape.
 */
export interface RejectedBody {
  readonly status: 403;
  readonly reason: string;
}

// ---------------------------------------------------------------------------
// Server config + factory
// ---------------------------------------------------------------------------

export interface SupervisorConfig {
  /** Lifecycle state machine — `/healthz` reads `isReady()`. */
  readonly lifecycle: Lifecycle;
  /** Per-boot uuid (echoed in `/healthz` + `/hello`). */
  readonly bootId: string;
  /** Daemon version string (echoed in `/healthz` + `/hello`). */
  readonly version: string;
  /**
   * Process start time in ms since epoch. `/healthz.uptimeS` is computed as
   * `Math.floor((nowMs - startTimeMs) / 1000)`. Caller passes
   * `Date.now()` once at boot so tests can stub a fixed value.
   */
  readonly startTimeMs: number;
  /**
   * Admin allowlist — defaults to `defaultAdminAllowlist()` if omitted.
   * Tests inject custom sets to drive allow/deny branches.
   */
  readonly adminAllowlist?: AdminAllowlist;
  /**
   * UDS peer-cred syscall callback (POSIX). Defaults to the unsupported
   * placeholder from `../auth/peer-cred` so a missing addon fails loud
   * the moment a peer connects — same fail-loud philosophy as Listener A.
   */
  readonly udsLookup?: UdsLookup;
  /**
   * Named-pipe peer-cred syscall callback (Windows). Defaults to the
   * unsupported placeholder.
   */
  readonly namedPipeLookup?: NamedPipeLookup;
  /**
   * Optional Windows-only "is this SID a member of BUILTIN\Administrators
   * group?" callback. T1.7 ships the structural admin gate; the runtime
   * token-membership query lands alongside the named-pipe DACL setup
   * (T1.5 + ch10 §5 installer).
   */
  readonly isMemberOfAdministrators?: (sid: string) => boolean;
  /**
   * Wall-clock provider for `/healthz.uptimeS`. Defaulted to `Date.now`;
   * tests inject a stub.
   */
  readonly now?: () => number;
  /**
   * Shutdown trigger. Called once when an authorized `/shutdown` arrives,
   * AFTER the response has been written. The supervisor server itself
   * does NOT close the process — graceful shutdown is owned by T1.8 (the
   * daemon entrypoint), which the callback hooks into. The supervisor
   * just delivers the "an admin asked us to stop" signal.
   *
   * The callback receives the `grace_ms` budget echoed in the response so
   * the entrypoint can honour the same deadline.
   */
  readonly onShutdown: (graceMs: number) => void;
  /**
   * Grace budget (ms) returned in `ShutdownResponse.grace_ms`. Spec ch02 §4
   * pins ≤ 5000ms (5s in-flight RPC budget). Defaults to 5000.
   */
  readonly shutdownGraceMs?: number;
  /** Address to bind: UDS path on POSIX, `\\.\pipe\<name>` on Windows. */
  readonly address: string;
  /**
   * Recovery flag (T5.7 / Task #60 — ch07 §6). Read on every `/healthz`
   * to surface `recovery_modal` to Electron; cleared by `/ack-recovery`
   * (admin-only).
   *
   * Optional so existing tests / smoke runs that don't care about
   * recovery still work — defaulting here to a fresh cleared flag means
   * `/healthz.recovery_modal.pending = false` and `/ack-recovery` is a
   * no-op admin endpoint.
   */
  readonly recoveryFlag?: RecoveryFlag;
}

/**
 * The supervisor server handle. `start()` binds the UDS / named-pipe;
 * `stop()` closes it. Mirrors the Listener trait shape (spec ch03 §1) but
 * is intentionally NOT a `Listener` instance — Supervisor is admin-only
 * and lives outside the listener-array slots (ch03 §7 first paragraph
 * "Separate from data-plane Listener A").
 */
export interface SupervisorServer {
  /** Bind the UDS / named-pipe. Throws if the address is busy. */
  start(): Promise<void>;
  /** Close the server. Idempotent. */
  stop(): Promise<void>;
  /**
   * Bound address (== config.address after `start()`). Exposed so the
   * descriptor writer (ch03 §3.2 `supervisorAddress` field) can echo it.
   */
  address(): string;
}

/**
 * Build the supervisor server. Does NOT call `listen` — caller invokes
 * `start()` so wiring errors stay within the entrypoint's phase
 * STARTING_LISTENERS handling.
 *
 * The construction-time runtime assert below pins the URL constants equal
 * to the literal strings the spec / golden contract requires; this is the
 * "two layers of belt-and-suspenders" pattern (compile-time `as const`,
 * runtime equality check, golden file).
 */
export function makeSupervisorServer(config: SupervisorConfig): SupervisorServer {
  // Runtime guard against a careless edit that retypes the constants.
  // The contract spec (test/supervisor/contract.spec.ts) is the other half
  // of the gate; reviewers grep for both when touching these strings.
  if (
    SUPERVISOR_URLS.healthz !== '/healthz' ||
    SUPERVISOR_URLS.hello !== '/hello' ||
    SUPERVISOR_URLS.shutdown !== '/shutdown' ||
    SUPERVISOR_URLS.ackRecovery !== '/ack-recovery'
  ) {
    throw new Error('SUPERVISOR_URLS drift — see ch15 §3 #9 + test/supervisor/contract.spec.ts');
  }

  const allowlist = config.adminAllowlist ?? defaultAdminAllowlist();
  const now = config.now ?? Date.now;
  const graceMs = config.shutdownGraceMs ?? 5000;
  const recoveryFlag = config.recoveryFlag ?? makeRecoveryFlag();

  const server = createServer((req, res) => {
    handleRequest(req, res, {
      ...config,
      adminAllowlist: allowlist,
      now,
      shutdownGraceMs: graceMs,
      recoveryFlag,
    }).catch((err) => {
      // Defensive: `handleRequest` never throws in the happy path. If a
      // syscall in peer-cred extraction throws AFTER headers are sent,
      // we end the connection silently (the client already saw the
      // earlier bytes). 500 with no body otherwise.
      if (!res.headersSent) {
        writeJson(res, 500, { status: 500, reason: errMessage(err) });
      } else {
        res.end();
      }
    });
  });

  let started = false;
  let stopped = false;

  return {
    address: () => config.address,
    async start() {
      if (started) throw new Error('SupervisorServer.start() called twice');
      started = true;
      await new Promise<void>((resolve, reject) => {
        const onError = (err: Error) => {
          server.removeListener('listening', onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          resolve();
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(config.address);
      });
    },
    async stop() {
      if (!started || stopped) return;
      stopped = true;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // `server.close` only stops accepting new conns; existing keep-alive
        // sockets need an explicit nudge. The supervisor has no streaming
        // endpoints so closeAllConnections is safe.
        server.closeAllConnections?.();
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Request dispatch
// ---------------------------------------------------------------------------

interface DispatchConfig extends SupervisorConfig {
  readonly adminAllowlist: AdminAllowlist;
  readonly now: () => number;
  readonly shutdownGraceMs: number;
  readonly recoveryFlag: RecoveryFlag;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: DispatchConfig,
): Promise<void> {
  // node:http normalises the URL to start with `/`; strip query string for
  // the route compare (the supervisor accepts no query args, but a stray
  // `?` should not 404 a /healthz probe).
  const url = (req.url ?? '').split('?')[0] ?? '';
  const method = req.method ?? '';

  // Route on (method, path) tuple. Anything else → 404 with no body.
  if (method === SUPERVISOR_METHODS.healthz && url === SUPERVISOR_URLS.healthz) {
    return handleHealthz(res, cfg);
  }
  if (method === SUPERVISOR_METHODS.hello && url === SUPERVISOR_URLS.hello) {
    return handleAdminEndpoint(req, res, cfg, 'hello');
  }
  if (method === SUPERVISOR_METHODS.shutdown && url === SUPERVISOR_URLS.shutdown) {
    return handleAdminEndpoint(req, res, cfg, 'shutdown');
  }
  if (
    method === SUPERVISOR_METHODS.ackRecovery &&
    url === SUPERVISOR_URLS.ackRecovery
  ) {
    return handleAdminEndpoint(req, res, cfg, 'ackRecovery');
  }

  res.statusCode = 404;
  res.end();
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

function handleHealthz(res: ServerResponse, cfg: DispatchConfig): void {
  // Spec ch03 §7: 200 only after phase READY; 503 before. The body shape
  // is identical in both cases. Spec ch07 §6 (T5.7) extends the body with
  // `recovery_modal: { pending, ts_ms, corrupt_path }` so Electron can
  // surface the corrupt-DB recovery modal on attach without a separate
  // RPC.
  const body: HealthzBody = {
    ready: cfg.lifecycle.isReady(),
    version: cfg.version,
    uptimeS: Math.max(0, Math.floor((cfg.now() - cfg.startTimeMs) / 1000)),
    boot_id: cfg.bootId,
    recovery_modal: cfg.recoveryFlag.read(),
  };
  writeJson(res, body.ready ? 200 : 503, body);
}

/** POST /ack-recovery body — spec ch07 §6 step 4(e). Empty success shape. */
export interface AckRecoveryBody {
  readonly meta: {
    readonly request_id: string;
    readonly client_version: string;
    readonly client_send_unix_ms: number;
  };
  readonly cleared: boolean;
}

async function handleAdminEndpoint(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: DispatchConfig,
  kind: 'hello' | 'shutdown' | 'ackRecovery',
): Promise<void> {
  // Drain the request body — POST endpoints accept no payload in v0.3 but
  // we MUST consume the bytes so keep-alive connections behave. (curl POST
  // sends an empty body unless `-d` is passed; this is a no-op then.)
  await drain(req);

  // Peer-cred extract → admin gate. Failure of either is a 403 with the
  // golden-shaped body. Spec ch03 §7.1: log the rejected peer; we delegate
  // logging to T9 by including the reason string in the response (the
  // crash collector / journald scrape captures it from there for now).
  let peer: UdsPeerCred | NamedPipePeerCred;
  try {
    peer = extractPeerForSupervisor(req.socket, cfg);
  } catch (err) {
    const body: RejectedBody = { status: 403, reason: `peer-cred lookup failed: ${errMessage(err)}` };
    writeJson(res, 403, body);
    return;
  }

  if (!isAllowed(cfg.adminAllowlist, peer, cfg.isMemberOfAdministrators)) {
    const body: RejectedBody = { status: 403, reason: 'peer-cred admin check failed' };
    writeJson(res, 403, body);
    return;
  }

  // Synthesise the proto-mirror `meta` block. The supervisor is HTTP not
  // Connect-RPC (spec ch03 §7), so there is no client-supplied request_id;
  // we mint a zero-uuid placeholder to keep the body shape stable. Real
  // request correlation belongs to T9's structured logger.
  const meta = {
    request_id: '00000000-0000-0000-0000-000000000000',
    client_version: '0.3.0',
    client_send_unix_ms: 0,
  } as const;

  if (kind === 'hello') {
    const body: HelloBody = {
      meta,
      daemon_version: cfg.version,
      boot_id: cfg.bootId,
    };
    writeJson(res, 200, body);
    return;
  }

  if (kind === 'ackRecovery') {
    // Spec ch07 §6 step 4(e): clears the in-memory recovery_modal flag.
    // Admin-only via the same peer-cred allowlist that gates /hello and
    // /shutdown — the corruption path is high-trust because the
    // operator/installer is the one who needs to sign off after a
    // diagnostics review (ch07 §6: "the corrupted database has been
    // preserved at <path> for diagnostics").
    cfg.recoveryFlag.clear();
    const body: AckRecoveryBody = { meta, cleared: true };
    writeJson(res, 200, body);
    return;
  }

  // shutdown — write the 200 response BEFORE invoking the trigger so the
  // caller (`installer uninstall` / `curl`) sees `accepted: true` even if
  // the daemon process exits a few ms later. Spec ch02 §4: budget is
  // 5000ms; the entrypoint is responsible for honouring it.
  const body: ShutdownBody = {
    meta,
    accepted: true,
    grace_ms: cfg.shutdownGraceMs,
  };
  writeJson(res, 200, body);
  // Let the response flush before the entrypoint starts terminating
  // sockets. `setImmediate` is enough — the response was already
  // synchronously serialized into the socket buffer by `writeJson`.
  setImmediate(() => {
    try {
      cfg.onShutdown(cfg.shutdownGraceMs);
    } catch {
      // Swallow — the supervisor cannot do anything useful with a
      // shutdown-callback failure; T9 logger picks it up upstream.
    }
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pick the right peer-cred extractor for the current platform. The
 * supervisor is UDS-only on every OS (ch03 §7), so the choice is a clean
 * `process.platform === 'win32'` branch — there is no loopback-TCP path
 * to consider.
 */
function extractPeerForSupervisor(
  socket: Socket,
  cfg: DispatchConfig,
): UdsPeerCred | NamedPipePeerCred {
  if (process.platform === 'win32') {
    return extractNamedPipePeerCred(socket, cfg.namedPipeLookup);
  }
  return extractUdsPeerCred(socket, cfg.udsLookup);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', Buffer.byteLength(payload).toString());
  // No-cache by default — `/healthz` MUST reflect live phase, the others
  // are admin actions.
  res.setHeader('cache-control', 'no-store');
  res.end(payload);
}

function drain(req: IncomingMessage): Promise<void> {
  return new Promise((resolve, reject) => {
    req.on('data', () => {});
    req.on('end', () => resolve());
    req.on('error', reject);
  });
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// Re-export the underlying `Server` type for callers that need direct
// access to `.address()` for an ephemeral-bind test scenario; supervisor
// does NOT expose its own ephemeral mode (production binds the spec path).
export type { Server };
