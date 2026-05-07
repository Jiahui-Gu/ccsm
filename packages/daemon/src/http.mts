// HTTP server: static SPA + REST sessions API (DESIGN.md §4, F1, F3).
// In-memory session stub only — real PTY spawn lives in T4. Frame codec and
// ws server also live in T4; this module deliberately knows nothing about them.

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
  SessionInfo,
} from '@ccsm/shared';

import { requireAuth } from './auth.mjs';
import type { KvDb } from './db.mjs';
import {
  createPersistController,
  loadSessionsFromDb,
  type PersistController,
} from './persist.mjs';

// API path constants — duplicated locally (not imported as a runtime value
// from @ccsm/shared) so the daemon does not pull in @ccsm/shared at runtime.
// The shared package is type-only here. The integration test asserts these
// paths against the URL shapes in DESIGN.md §4; the contract types above
// keep response shape drift caught by the typechecker.
const API_SESSIONS = '/api/sessions';

// Resolve frontend dist relative to this source file. After tsc build the
// emitted file lives at packages/daemon/dist/http.mjs, so going up two dirs
// lands in packages/daemon, and one more in packages/, giving us
// packages/frontend/dist.
const HERE = fileURLToPath(new URL('.', import.meta.url));
const FRONTEND_DIST = resolve(HERE, '..', '..', 'frontend', 'dist');
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

// NOTE (T4): added optional `cwd` so the ws layer (ws.mts) can spawn the
// node-pty in the right working directory. Routing/auth logic untouched.
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
}

export interface DaemonHttp {
  server: Server;
  sessions: Map<string, StubSession>;
  /** Persist controller. `null` when no db was supplied. The daemon entry
   *  point uses this to flushNow() on SIGINT before closing the db. */
  persist: PersistController | null;
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

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return await new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 64 * 1024; // 64 KiB ceiling for stub session-create payloads
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
  // urlPath looks like /assets/foo.js — strip leading /assets/.
  const rel = urlPath.replace(/^\/assets\//, '');
  if (rel.length === 0 || rel.includes('\0')) {
    writeText(res, 404, 'not found');
    return;
  }
  const target = normalize(join(FRONTEND_ASSETS, rel));
  // Path traversal guard: target must stay inside FRONTEND_ASSETS.
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

async function handleApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  sessions: Map<string, StubSession>,
  expectedToken: string,
  persist: PersistController | null,
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
    // T4: persist cwd so ws.mts can spawn node-pty with it.
    const sid = randomUUID();
    const createdAt = Date.now();
    const stub: StubSession = { sid, createdAt, alive: true };
    if (typeof body.cwd === 'string' && body.cwd.length > 0) {
      stub.cwd = body.cwd;
    }
    sessions.set(sid, stub);
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

  // DELETE /api/sessions/:sid
  if (path.startsWith(`${API_SESSIONS}/`) && method === 'DELETE') {
    const sid = decodeURIComponent(path.slice(API_SESSIONS.length + 1));
    if (sid.length === 0 || sid.includes('/')) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    if (!sessions.has(sid)) {
      writeJson(res, 404, { error: 'not_found' });
      return;
    }
    sessions.delete(sid);
    persist?.scheduleFlush();
    const resp: DeleteSessionResponse = { ok: true };
    writeJson(res, 200, resp);
    return;
  }

  writeJson(res, 404, { error: 'not_found' });
}

/**
 * Build (but do not start) the daemon HTTP server. Caller is responsible for
 * `.listen()` and lifecycle.
 */
export function createDaemonHttp(opts: DaemonHttpOptions): DaemonHttp {
  const sessions = new Map<string, StubSession>();
  const expectedToken = opts.token;

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

      // Static SPA shell. The browser strips the query before the server
      // ever sees it for static GETs, but `new URL` handles either way.
      if (path === '/' && method === 'GET') {
        serveIndex(res);
        return;
      }

      if (path.startsWith('/assets/') && method === 'GET') {
        serveAsset(res, path);
        return;
      }

      if (path.startsWith('/api/')) {
        await handleApi(req, res, url, sessions, expectedToken, persist);
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

  return { server, sessions, persist };
}
