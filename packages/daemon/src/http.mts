// HTTP server: static SPA + REST sessions API (DESIGN.md §4, F1, F3).
//
// Task #668: PTY spawn moved here from ws.mts. POST /api/sessions both creates
// a session row and synchronously spawns `claude --session-id <sid>`.
// POST /api/sessions/:sid/resume re-spawns `claude --resume <sid>` for an
// existing session row whose runtime has died (e.g. after a daemon restart
// once #667 lands). DELETE /api/sessions/:sid kills the runtime + drops the
// stub. WS /ws is now subscribe-only — see ws.mts.

import { randomUUID } from 'node:crypto';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CreateSessionRequest,
  CreateSessionResponse,
  DeleteSessionResponse,
  ListSessionsResponse,
  ResumeSessionResponse,
  SessionInfo,
} from '@ccsm/shared';

import { classifyOrigin, requireAuth } from './auth.mjs';
import type { KvDb } from './db.mjs';
import {
  createPersistController,
  loadSessionsFromDb,
  type PersistController,
} from './persist.mjs';
import type { RuntimeRegistry } from './runtime.mjs';

const API_SESSIONS = '/api/sessions';

const HERE = fileURLToPath(new URL('.', import.meta.url));
// Path to the built SPA. The frontend package was renamed
// `packages/frontend` -> `packages/frontend-web` in T6 (#686); keep this in
// sync or `GET /` returns 503 "frontend not built". The
// `serves built SPA` test in test/http.test.ts pins this so future renames
// fail loudly.
const FRONTEND_DIST = resolve(HERE, '..', '..', 'frontend-web', 'dist');
const FRONTEND_INDEX = join(FRONTEND_DIST, 'index.html');
const FRONTEND_ASSETS = join(FRONTEND_DIST, 'assets');

const MIME_TYPES: Record<string, string> = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export interface StubSession {
  sid: string;
  createdAt: number;
  alive: boolean;
  cwd?: string | undefined;
}

export interface DaemonHttpOptions {
  token: string;
  /** Optional KV-db handle. When provided:
   *   - existing 'sessions' blob is loaded into the in-memory map at boot
   *   - mutations (POST/DELETE) trigger a debounced write back
   *  Omit in tests that don't care about persistence. */
  db?: KvDb;
  /** Override the persist debounce window (ms). Tests use this to make the
   *  flush deterministic; production uses the default. */
  persistDebounceMs?: number;
  /**
   * Optional runtime registry. When present, POST /api/sessions and the new
   * POST /api/sessions/:sid/resume route synchronously spawn / re-spawn the
   * PTY before responding. When omitted (legacy callers / unit tests that
   * only exercise auth) the routes degrade to the stub-only behaviour.
   */
  registry?: RuntimeRegistry;
}

export interface DaemonHttp {
  server: Server;
  sessions: Map<string, StubSession>;
  /** Persist controller. `null` when no db was supplied. The daemon entry
   *  point uses this to flushNow() on SIGINT before closing the db. */
  persist: PersistController | null;
  /**
   * Inject the runtime registry after construction. We expose this as a
   * setter so index.mts can break the http<->registry construction cycle
   * (registry needs http.sessions; http needs registry to spawn). Tests that
   * exercise the spawn paths can also pass `registry` up-front via opts.
   */
  setRegistry(registry: RuntimeRegistry): void;
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function writeText(res: ServerResponse, status: number, body: string): void {
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(body);
}

// ---- CORS (T2 #675) -----------------------------------------------------
// All `/api/*` responses (including 401/403/404/500) carry CORS headers so
// browsers (web SPA same-origin via vite proxy / Tauri webview at
// `tauri://localhost`) can read the body. The Tauri webview treats fetches
// to http://127.0.0.1:* as cross-origin, hence we need real CORS even though
// the daemon is loopback-only.
//
// We echo the request Origin when it's allow-listed (loopback/tauri); for
// any other case (incl. absent header — same-origin) we fall back to '*'.
// '*' is safe because we DO NOT use cookies — auth is a Bearer token in the
// `Authorization` header which the SPA / Tauri shell injects explicitly.
//
// Vary: Origin is set so any caching layer keys on the Origin header.
const CORS_ALLOW_HEADERS = 'Authorization, Content-Type';
const CORS_ALLOW_METHODS = 'GET, POST, DELETE, OPTIONS';

function applyCorsHeaders(req: IncomingMessage, res: ServerResponse): void {
  const rawOrigin = req.headers.origin;
  const origin = typeof rawOrigin === 'string' && rawOrigin.length > 0 ? rawOrigin : undefined;
  const allowOrigin = origin !== undefined && classifyOrigin(origin) === 'allowed' ? origin : '*';
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  // No credentials: we use Bearer tokens, not cookies.
}

function handleCorsPreflight(req: IncomingMessage, res: ServerResponse): void {
  applyCorsHeaders(req, res);
  // Cache preflight for 10 min — keeps Tauri webview from re-issuing OPTIONS
  // on every fetch. Spec lets browsers cap at their discretion (Chromium 2h).
  res.setHeader('Access-Control-Max-Age', '600');
  // S2 #702 / R-53 #175 — Chrome 120+ Private Network Access (PNA): when a public-network
  // page (https://ccsm-worker.jiahuigu.workers.dev) initiates a fetch to a private/loopback
  // address (127.0.0.1), the browser sends `Access-Control-Request-Private-
  // Network: true` on the preflight and REQUIRES the response to echo back
  // `Access-Control-Allow-Private-Network: true`, otherwise the actual
  // request never fires. We only echo on demand (don't advertise the header
  // to peers that didn't ask).
  // Spec: https://wicg.github.io/private-network-access/#cors-preflight
  if (req.headers['access-control-request-private-network'] === 'true') {
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
  }
  // Spec allows 200 or 204; manager validation script greps for 200 explicitly.
  res.statusCode = 200;
  res.end();
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        rejectBody(new Error('payload_too_large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw.length === 0) {
        resolveBody({});
        return;
      }
      try {
        resolveBody(JSON.parse(raw));
      } catch (err) {
        rejectBody(err);
      }
    });
    req.on('error', rejectBody);
  });
}

function serveStaticFile(res: ServerResponse, absPath: string): void {
  if (!existsSync(absPath) || !statSync(absPath).isFile()) {
    writeText(res, 404, 'not found');
    return;
  }
  const ext = extname(absPath).toLowerCase();
  const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
  res.statusCode = 200;
  res.setHeader('content-type', mime);
  createReadStream(absPath).pipe(res);
}

function serveIndex(res: ServerResponse): void {
  if (!existsSync(FRONTEND_INDEX)) {
    writeText(res, 503, 'frontend not built');
    return;
  }
  serveStaticFile(res, FRONTEND_INDEX);
}

function serveAsset(res: ServerResponse, urlPath: string): void {
  const rel = urlPath.replace(/^\/assets\//, '');
  if (rel.length === 0 || rel.includes('\0')) {
    writeText(res, 404, 'not found');
    return;
  }
  const target = normalize(join(FRONTEND_ASSETS, rel));
  const assetsRoot = FRONTEND_ASSETS.endsWith(sep) ? FRONTEND_ASSETS : FRONTEND_ASSETS + sep;
  if (target !== FRONTEND_ASSETS && !target.startsWith(assetsRoot)) {
    writeText(res, 404, 'not found');
    return;
  }
  serveStaticFile(res, target);
}

function toSessionInfo(s: StubSession): SessionInfo {
  return { sid: s.sid, createdAt: s.createdAt, alive: s.alive };
}

// Match `/api/sessions/:sid` and `/api/sessions/:sid/resume`. Returns null if
// neither shape matches. The sid segment is decoded; resume is a literal flag.
function parseSessionPath(path: string): { sid: string; resume: boolean } | null {
  if (!path.startsWith(`${API_SESSIONS}/`)) return null;
  const rest = path.slice(API_SESSIONS.length + 1);
  if (rest.length === 0) return null;
  const segments = rest.split('/');
  if (segments.length === 1) {
    const sid = decodeURIComponent(segments[0] as string);
    if (sid.length === 0) return null;
    return { sid, resume: false };
  }
  if (segments.length === 2 && segments[1] === 'resume') {
    const sid = decodeURIComponent(segments[0] as string);
    if (sid.length === 0) return null;
    return { sid, resume: true };
  }
  return null;
}

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessions: Map<string, StubSession>,
  expectedToken: string,
  persist: PersistController | null,
  registry: RuntimeRegistry | undefined,
): Promise<void> {
  if (!requireAuth(req, res, expectedToken)) return;

  const method = req.method ?? 'GET';
  const path = url.pathname;

  // POST /api/sessions
  if (path === API_SESSIONS && method === 'POST') {
    let body: CreateSessionRequest;
    try {
      const parsed = (await readJsonBody(req)) as CreateSessionRequest;
      body = parsed ?? {};
    } catch {
      writeJson(res, 400, { error: 'bad_json' });
      return;
    }
    const sid = randomUUID();
    const createdAt = Date.now();
    const stub: StubSession = { sid, createdAt, alive: true };
    if (typeof body.cwd === 'string' && body.cwd.length > 0) {
      stub.cwd = body.cwd;
    }
    sessions.set(sid, stub);

    if (registry) {
      // T#668: spawn the PTY synchronously. If it fails, roll back the stub
      // so a retry can mint a fresh sid (and the user doesn't see a ghost row
      // they can't connect to).
      const spawned = registry.spawn(sid, stub, 'create');
      if (!spawned) {
        sessions.delete(sid);
        writeJson(res, 500, { error: 'pty_spawn_failed' });
        return;
      }
    }

    persist?.scheduleFlush();
    const resp: CreateSessionResponse = { sid, createdAt };
    writeJson(res, 200, resp);
    return;
  }

  // GET /api/sessions
  if (path === API_SESSIONS && method === 'GET') {
    const resp: ListSessionsResponse = {
      sessions: Array.from(sessions.values()).map(toSessionInfo),
    };
    writeJson(res, 200, resp);
    return;
  }

  // POST /api/sessions/:sid/resume  -- T#668
  // DELETE /api/sessions/:sid
  const parsed = parseSessionPath(path);
  if (parsed) {
    if (parsed.resume && method === 'POST') {
      const stub = sessions.get(parsed.sid);
      if (!stub) {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      // Idempotent: already alive -> just say ok. (Frontend may double-fire
      // resume on tab focus / reconnect; we don't want to leak PTYs.)
      if (registry?.has(parsed.sid)) {
        const resp: ResumeSessionResponse = { ok: true };
        writeJson(res, 200, resp);
        return;
      }
      if (!registry) {
        // No runtime layer attached at all -- not a state we hit in prod, but
        // it keeps the route honest under unit-test isolation.
        writeJson(res, 500, { error: 'no_runtime' });
        return;
      }
      const spawned = registry.spawn(parsed.sid, stub, 'resume');
      if (!spawned) {
        writeJson(res, 500, { error: 'pty_spawn_failed' });
        return;
      }
      // Mark the stub as alive again so subsequent GET reflects state.
      stub.alive = true;
      persist?.scheduleFlush();
      const resp: ResumeSessionResponse = { ok: true };
      writeJson(res, 200, resp);
      return;
    }

    if (!parsed.resume && method === 'DELETE') {
      if (!sessions.has(parsed.sid)) {
        writeJson(res, 404, { error: 'not_found' });
        return;
      }
      // T#668: also tear down any live PTY so the OS doesn't leak processes.
      // Task #758: AWAIT the kill so the EXIT frame (FrameType=0x07) lands on
      // OPEN ws subscribers BEFORE we reply 200. Client SPAs detach their ws
      // only after seeing the DELETE response, so as long as we broadcast
      // first the client's ws is still in OPEN state when the daemon's
      // onExit fan-out runs. registry.kill resolves once the EXIT broadcast
      // has run (or after a 2000ms timeout for wedged PTYs — we still 200
      // to avoid HTTP hang).
      if (registry) {
        await registry.kill(parsed.sid);
      }
      sessions.delete(parsed.sid);
      persist?.scheduleFlush();
      const resp: DeleteSessionResponse = { ok: true };
      writeJson(res, 200, resp);
      return;
    }
  }

  writeJson(res, 404, { error: 'not_found' });
}

export function createDaemonHttp(opts: DaemonHttpOptions): DaemonHttp {
  const sessions = new Map<string, StubSession>();
  const expectedToken = opts.token;
  let registry: RuntimeRegistry | undefined = opts.registry;

  // Persistence wiring (#667). When a db is supplied we hydrate the map
  // from the 'sessions' KV blob before the server starts accepting
  // requests, then arm the debounced writer for subsequent mutations.
  let persist: PersistController | null = null;
  if (opts.db) {
    loadSessionsFromDb(opts.db, sessions);
    const persistOpts: Parameters<typeof createPersistController>[0] = {
      db: opts.db,
      sessions,
    };
    if (opts.persistDebounceMs !== undefined) {
      persistOpts.debounceMs = opts.persistDebounceMs;
    }
    persist = createPersistController(persistOpts);
  }

  const server = createServer((req, res) => {
    void handle(req, res);
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const path = url.pathname;
      const method = req.method ?? 'GET';

      if (path === '/' && method === 'GET') {
        serveIndex(res);
        return;
      }

      if (path.startsWith('/assets/') && method === 'GET') {
        serveAsset(res, path);
        return;
      }

      if (path.startsWith('/api/')) {
        // CORS headers attach to EVERY /api/* response (including
        // requireAuth's 401/403). Preflight short-circuits before auth.
        applyCorsHeaders(req, res);
        if (method === 'OPTIONS') {
          handleCorsPreflight(req, res);
          return;
        }
        await handleApi(req, res, url, sessions, expectedToken, persist, registry);
        return;
      }

      // GET /token — Task #696. Loopback-only daemon (listens on 127.0.0.1)
      // exposes the current bearer token to the same-origin SPA so the web
      // shell can bootstrap without a `?token=` URL param. Safe because:
      //   * server only binds 127.0.0.1 (see index.mts), so a remote attacker
      //     cannot reach this port at all;
      //   * any local process can already read CCSM_TOKEN from env / from the
      //     handshake stdout, so this endpoint exposes no new capability.
      // We still apply CORS so the Tauri webview / dev vite proxy can read
      // the body, mirroring /api/*. No auth required.
      if (path === '/token' && method === 'GET') {
        applyCorsHeaders(req, res);
        writeJson(res, 200, { token: expectedToken });
        return;
      }
      if (path === '/token' && method === 'OPTIONS') {
        handleCorsPreflight(req, res);
        return;
      }

      writeText(res, 404, 'not found');
    } catch (err) {
      console.error('[ccsm] http handler error:', err);
      if (!res.headersSent) {
        writeJson(res, 500, { error: 'internal' });
      } else {
        try {
          res.end();
        } catch {
          // ignore
        }
      }
    }
  }

  return {
    server,
    sessions,
    persist,
    setRegistry(r) {
      registry = r;
    },
  };
}
