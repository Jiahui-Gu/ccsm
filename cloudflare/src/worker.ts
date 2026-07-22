/* global Headers, Request, Response */

import type {
  DurableObjectNamespace,
  Fetcher,
  RateLimit,
} from 'cloudflare:workers';

import type { RelayRole } from '../../src/shared/mobileRemote';
import { RelayRoom } from './relayRoom';

export { RelayRoom };

export type Env = {
  ASSETS: Fetcher;
  RELAY: DurableObjectNamespace<RelayRoom>;
  RELAY_RATE_LIMITER: RateLimit;
};

type ParsedRelayRequest =
  | {
      ok: true;
      value: {
        roomId: string;
        role: RelayRole;
      };
    }
  | {
      ok: false;
      status: number;
    };

const RELAY_PATH = /^\/relay\/([A-Za-z0-9_-]{43})$/;
const PHONE_CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "style-src-attr 'unsafe-inline'",
  "style-src-elem 'self' 'unsafe-inline'",
  "connect-src 'self' wss:",
  "manifest-src 'self'",
  "worker-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function parseRelayRequest(request: Request): ParsedRelayRequest {
  if (request.method !== 'GET') return { ok: false, status: 400 };

  const url = new URL(request.url);
  const match = RELAY_PATH.exec(url.pathname);
  if (!match) return { ok: false, status: 400 };

  if (url.searchParams.size !== 1 || url.searchParams.getAll('role').length !== 1) {
    return { ok: false, status: 400 };
  }
  const role = url.searchParams.get('role');
  if (role !== 'desktop' && role !== 'phone') {
    return { ok: false, status: 400 };
  }
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return { ok: false, status: 400 };
  }
  if (role === 'phone' && request.headers.get('Origin') !== url.origin) {
    return { ok: false, status: 400 };
  }

  return {
    ok: true,
    value: {
      roomId: match[1] as string,
      role,
    },
  };
}

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'GET' && !url.pathname.startsWith('/relay/')) {
      const asset = await env.ASSETS.fetch(request);
      const headers = new Headers(asset.headers);
      headers.set('Content-Security-Policy', PHONE_CSP);
      headers.set('X-Frame-Options', 'DENY');
      headers.set('X-Content-Type-Options', 'nosniff');
      return new Response(asset.body, {
        status: asset.status,
        statusText: asset.statusText,
        headers,
      });
    }

    const parsed = parseRelayRequest(request);
    if (!parsed.ok) {
      return new Response('Bad Request', { status: parsed.status });
    }

    const key = request.headers.get('CF-Connecting-IP') ?? 'unknown';
    const outcome = await env.RELAY_RATE_LIMITER.limit({ key });
    if (!outcome.success) {
      return new Response('Too Many Requests', { status: 429 });
    }

    return env.RELAY.getByName(parsed.value.roomId).fetch(request);
  },
};

export default worker;
