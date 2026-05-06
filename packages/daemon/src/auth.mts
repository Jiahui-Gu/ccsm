// Token + origin auth for /api/* routes (DESIGN.md §4, G5).
// Static GET / and /assets/* DO NOT call this — the SPA bootstraps from the
// URL token before any /api/* request is made.

import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const ALLOWED_ORIGIN_HOSTS = new Set(['127.0.0.1', 'localhost']);
const ALLOWED_ORIGIN_PROTOCOLS = new Set(['http:', 'https:']);

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

function constantTimeEquals(a: string, b: string): boolean {
  // timingSafeEqual requires equal-length buffers; pad to avoid leaking length.
  const aBuf = Buffer.from(a, 'utf8');
  const bBuf = Buffer.from(b, 'utf8');
  if (aBuf.length !== bBuf.length) {
    // Still do a compare on a same-length buffer to keep timing similar.
    const filler = Buffer.alloc(aBuf.length, 0);
    timingSafeEqual(aBuf, filler);
    return false;
  }
  return timingSafeEqual(aBuf, bBuf);
}

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return false;
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (!ALLOWED_ORIGIN_PROTOCOLS.has(url.protocol)) return false;
  return ALLOWED_ORIGIN_HOSTS.has(url.hostname);
}

function extractBearer(header: string | string[] | undefined): string | null {
  if (typeof header !== 'string') return null;
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m && m[1] ? m[1].trim() : null;
}

/**
 * Validates token + origin for /api/* requests. On rejection writes a JSON
 * error response and returns false; caller should not write further.
 */
export function requireAuth(
  req: IncomingMessage,
  res: ServerResponse,
  expectedToken: string,
): boolean {
  const origin = req.headers.origin;
  if (!isAllowedOrigin(typeof origin === 'string' ? origin : undefined)) {
    console.warn(
      `[ccsm] auth: rejected origin=${JSON.stringify(origin ?? null)} url=${req.url}`,
    );
    writeJson(res, 403, { error: 'forbidden_origin' });
    return false;
  }

  const presented = extractBearer(req.headers.authorization);
  if (!presented || !constantTimeEquals(presented, expectedToken)) {
    console.warn(
      `[ccsm] auth: rejected token (presented=${presented ? 'yes' : 'no'}) url=${req.url}`,
    );
    writeJson(res, 401, { error: 'unauthorized' });
    return false;
  }

  return true;
}
