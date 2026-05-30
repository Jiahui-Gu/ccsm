import * as crypto from 'crypto';
import * as http from 'http';

export const DEFAULT_PORT = 4177;
export const HOST = '127.0.0.1';

/** Constant-time token comparison to avoid leaking a timing oracle on the
 *  bearer token. Length is not secret, so an early length-mismatch return is
 *  fine; the byte comparison itself is constant-time via timingSafeEqual. */
export function tokenMatches(provided: string | null, expected: string): boolean {
  if (provided === null) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function resolvePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

export function parseRequestUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw, `http://${HOST}`);
  } catch {
    return null;
  }
}

export function sendHtml(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
