import * as crypto from 'crypto';
import * as http from 'http';
import * as os from 'os';

export const DEFAULT_PORT = 4177;
export const DEFAULT_HOST = '127.0.0.1';

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

/** Validate the bind host. Accepts the loopback/all-interfaces sentinels and
 *  bare IPv4 literals; anything else (hostname, typo, empty) falls back to
 *  loopback so a malformed env var never binds a surprising interface. The
 *  feature stays secure-by-default: exposing beyond loopback requires a
 *  deliberate, well-formed CCSM_MOBILE_REMOTE_HOST. */
export function resolveHost(raw: string | undefined): string {
  if (!raw) return DEFAULT_HOST;
  const v = raw.trim();
  if (v === '0.0.0.0' || v === '127.0.0.1') return v;
  if (/^(\d{1,3}\.){3}\d{1,3}$/.test(v)) {
    const octets = v.split('.').map(Number);
    if (octets.every((o) => o >= 0 && o <= 255)) return v;
  }
  return DEFAULT_HOST;
}

/** The desktop's primary LAN IPv4 (first non-internal IPv4), or null when the
 *  machine has no external interface. Used to show a phone-reachable display
 *  URL when the server is bound beyond loopback — 0.0.0.0 is not an address a
 *  phone can open. */
export function primaryLanIPv4(): string | null {
  const ifaces = os.networkInterfaces();
  for (const addrs of Object.values(ifaces)) {
    for (const a of addrs ?? []) {
      if (a.family === 'IPv4' && !a.internal) return a.address;
    }
  }
  return null;
}

/** Map the bound host to an address a phone can actually reach. Loopback stays
 *  loopback; a non-loopback bind (0.0.0.0 or a specific NIC) resolves to the
 *  primary LAN IP, falling back to the bind literal when no LAN IP exists. */
export function displayHost(boundHost: string): string {
  if (boundHost === '127.0.0.1') return '127.0.0.1';
  return primaryLanIPv4() ?? boundHost;
}

export function parseRequestUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    // Base host is parse-only: it merely lets the URL constructor resolve a
    // relative request-target so we can read pathname/searchParams. It is never
    // inspected, so it is intentionally independent of the bind address.
    return new URL(raw, 'http://localhost');
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

export function sendJson(res: http.ServerResponse, body: unknown): void {
  res.writeHead(200, {
    'content-type': 'application/manifest+json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
