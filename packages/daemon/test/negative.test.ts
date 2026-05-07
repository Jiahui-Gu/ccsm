// T12 (#655) — consolidated negative-path tests for the daemon HTTP/WS layer.
//
// Coverage gaps versus existing suites: this file does NOT duplicate the
// happy-path CRUD coverage from auth.test.ts or the frame round-trip coverage
// from ws.test.ts. Instead it walks a single curated checklist of failure
// modes the reviewer can read top-to-bottom:
//
//   HTTP /api/*
//     1. missing Authorization header                                  -> 401 + JSON error
//     2. malformed Authorization (no Bearer prefix)                    -> 401 + JSON error
//     3. wrong Bearer token                                            -> 401 + JSON error
//     4. wrong-length Bearer token (constant-time path, length differs)-> 401
//     5. Origin from non-allowed host                                  -> 403 + JSON error
//     6. Origin with non-http(s) protocol (file://)                    -> 403
//     7. Unparseable Origin                                            -> 403
//     8. missing Origin (#672) — treated as same-origin, 200 if token valid;
//        wrong token still 401 (8b) so dropping Origin can't bypass auth.
//   WS /ws upgrade
//     9. no token query param                                          -> close (handshake refused)
//    10. wrong token query param                                       -> close (handshake refused)
//    11. bad Origin                                                    -> close (handshake refused)
//    12. missing Origin                                                -> close (handshake refused)
//    13. unknown sid                                                   -> close (handshake refused)
//    14. missing sid                                                   -> close (handshake refused)
//    15. garbage lastSeq is ignored (does NOT close)                   -> ws opens
//
// Notes:
//   * HTTP responses include a JSON error body shape `{ error: string }`. We
//     assert the shape so a future refactor that drops the body or changes
//     the key is caught here.
//   * WS upgrade rejections surface in the `ws` client as an abnormal close
//     (code 1006) — the underlying HTTP status (401/403/404) is not exposed
//     to the JS WebSocket API. We therefore assert "did not open" rather than
//     a specific close code, mirroring ws.test.ts.

import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';
import {
  createRuntimeRegistry,
  type PtyFactory,
  type PtyLike,
} from '../src/runtime.mjs';
import { attachWebSocket, type AttachedWs } from '../src/ws.mjs';

const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef';
const GOOD_ORIGIN = 'http://localhost:1234';

// Fake PTY that never spawns anything — reused only so attachWebSocket has
// a non-throwing factory. None of the tests in this file should ever cause
// a PTY to be created (every WS case rejects pre-handshake), so we additionally
// assert the spawn count stays at zero.
let ptySpawnCount = 0;
const noopPtyFactory: PtyFactory = () => {
  ptySpawnCount += 1;
  const pty: PtyLike = {
    write: () => {},
    resize: () => {},
    kill: () => {},
    onData: () => {},
    onExit: () => {},
  };
  return pty;
};

let http: DaemonHttp;
let attached: AttachedWs;
let baseHttp: string;
let baseWs: string;
let validSid: string;

beforeAll(async () => {
  http = createDaemonHttp({ token: TOKEN });
  const registry = createRuntimeRegistry({
    sessions: http.sessions,
    ptyFactory: noopPtyFactory,
  });
  http.setRegistry(registry);
  attached = attachWebSocket(http.server, {
    token: TOKEN,
    sessions: http.sessions,
    registry,
  });
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(0, '127.0.0.1', () => {
      http.server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = http.server.address() as AddressInfo;
  baseHttp = `http://127.0.0.1:${addr.port}`;
  baseWs = `ws://127.0.0.1:${addr.port}`;

  // Provision a real session so the WS-only-failure cases below can isolate
  // the *failure under test* from "session does not exist".
  const r = await fetch(`${baseHttp}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: GOOD_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { sid: string };
  validSid = j.sid;
});

afterAll(async () => {
  await attached.shutdown();
  await new Promise<void>((resolve) => http.server.close(() => resolve()));
});

// ---- helpers ------------------------------------------------------------

interface DialResult {
  ws: WebSocket;
  closed: Promise<{ code: number; reason: string }>;
  opened: Promise<boolean>;
}

function dial(url: string, headers: Record<string, string> = {}): DialResult {
  // Caller may opt-out of an Origin header by passing { Origin: '' }; ws lib
  // treats undefined as "no header" but explicit empty string is dropped too.
  const baseHeaders: Record<string, string> = {};
  if (headers.Origin === undefined) {
    baseHeaders.Origin = GOOD_ORIGIN;
  }
  const merged = { ...baseHeaders, ...headers };
  if (merged.Origin === '') delete merged.Origin;

  const ws = new WebSocket(url, { headers: merged });
  const closed = new Promise<{ code: number; reason: string }>((resolve) => {
    ws.once('close', (code, reason) =>
      resolve({ code, reason: reason.toString('utf8') }),
    );
  });
  const opened = new Promise<boolean>((resolve) => {
    ws.once('open', () => resolve(true));
    ws.once('close', () => resolve(false));
    ws.once('error', () => {
      /* observable via close */
    });
  });
  return { ws, closed, opened };
}

async function expectErrorJson(
  resp: Response,
  status: number,
  errorName?: string,
): Promise<void> {
  expect(resp.status).toBe(status);
  const ct = resp.headers.get('content-type') ?? '';
  expect(ct).toMatch(/application\/json/);
  const body = (await resp.json()) as { error?: unknown };
  expect(typeof body.error).toBe('string');
  if (errorName !== undefined) expect(body.error).toBe(errorName);
}

// ---- HTTP negative cases -----------------------------------------------

describe('HTTP /api/* negative paths (T12)', () => {
  it('1. missing Authorization -> 401 + json error', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: { Origin: GOOD_ORIGIN },
    });
    await expectErrorJson(r, 401, 'unauthorized');
  });

  it('2. malformed Authorization (no Bearer prefix) -> 401', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: {
        Origin: GOOD_ORIGIN,
        Authorization: TOKEN, // missing "Bearer " prefix
      },
    });
    await expectErrorJson(r, 401, 'unauthorized');
  });

  it('3. wrong Bearer token (same length as expected) -> 401', async () => {
    const wrong = 'X'.repeat(TOKEN.length);
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: { Origin: GOOD_ORIGIN, Authorization: `Bearer ${wrong}` },
    });
    await expectErrorJson(r, 401, 'unauthorized');
  });

  it('4. wrong Bearer token (different length) -> 401', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: { Origin: GOOD_ORIGIN, Authorization: 'Bearer short' },
    });
    await expectErrorJson(r, 401, 'unauthorized');
  });

  it('5. Origin host not in allowlist -> 403 + json error', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: {
        Origin: 'http://evil.example.com',
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    await expectErrorJson(r, 403, 'forbidden_origin');
  });

  it('6. Origin protocol not http(s) -> 403', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: {
        Origin: 'file://localhost',
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    await expectErrorJson(r, 403, 'forbidden_origin');
  });

  it('7. unparseable Origin -> 403', async () => {
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: {
        Origin: 'not a url',
        Authorization: `Bearer ${TOKEN}`,
      },
    });
    await expectErrorJson(r, 403, 'forbidden_origin');
  });

  it('8. missing Origin -> 200 when token valid (#672: same-origin per fetch spec)', async () => {
    // Per the Fetch spec, browsers OMIT Origin on same-origin simple GETs.
    // Treat absent Origin as same-origin and pass — token is still verified.
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: { Authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
  });

  it('8b. missing Origin + wrong token -> 401 (token check still applies)', async () => {
    // Defense: dropping Origin must NOT skip token verification.
    const r = await fetch(`${baseHttp}/api/sessions`, {
      headers: { Authorization: 'Bearer wrong-token' },
    });
    await expectErrorJson(r, 401, 'unauthorized');
  });
});

// ---- WS negative cases --------------------------------------------------

describe('WS /ws upgrade negative paths (T12)', () => {
  it('9. no token query -> handshake refused (no open)', async () => {
    const before = ptySpawnCount;
    const d = dial(`${baseWs}/ws?sid=${validSid}`);
    const ok = await d.opened;
    expect(ok).toBe(false);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
    expect(ptySpawnCount).toBe(before);
  });

  it('10. wrong token query -> handshake refused', async () => {
    const before = ptySpawnCount;
    const d = dial(
      `${baseWs}/ws?sid=${validSid}&token=${'X'.repeat(TOKEN.length)}`,
    );
    const ok = await d.opened;
    expect(ok).toBe(false);
    expect(ptySpawnCount).toBe(before);
  });

  it('11. bad Origin -> handshake refused', async () => {
    const before = ptySpawnCount;
    const d = dial(
      `${baseWs}/ws?sid=${validSid}&token=${TOKEN}`,
      { Origin: 'http://evil.example.com' },
    );
    const ok = await d.opened;
    expect(ok).toBe(false);
    expect(ptySpawnCount).toBe(before);
  });

  it('12. missing Origin -> handshake ACCEPTED (same-origin per #672 / T2 #675)', async () => {
    // Updated for T2 #675: ws upgrade now mirrors HTTP auth — absent Origin
    // is treated as same-origin (browsers omit it on same-origin upgrades),
    // so the handshake must succeed. Token is still verified above.
    const before = ptySpawnCount;
    const d = dial(
      `${baseWs}/ws?sid=${validSid}&token=${TOKEN}`,
      { Origin: '' }, // sentinel: drop Origin entirely
    );
    const ok = await d.opened;
    expect(ok).toBe(true);
    // A subscriber on an existing runtime should NOT trigger a fresh spawn.
    expect(ptySpawnCount).toBe(before);
    d.ws.close();
  });

  it('13. unknown sid -> handshake refused, no PTY spawn', async () => {
    const before = ptySpawnCount;
    const d = dial(`${baseWs}/ws?sid=this-sid-does-not-exist&token=${TOKEN}`);
    const ok = await d.opened;
    expect(ok).toBe(false);
    expect(ptySpawnCount).toBe(before);
  });

  it('14. missing sid -> handshake refused', async () => {
    const before = ptySpawnCount;
    const d = dial(`${baseWs}/ws?token=${TOKEN}`);
    const ok = await d.opened;
    expect(ok).toBe(false);
    expect(ptySpawnCount).toBe(before);
  });

  it('15. garbage lastSeq is ignored (handshake still succeeds)', async () => {
    // PTY *will* spawn here — this is a happy-path with a malformed param
    // that the server should silently coerce to 0 (no replay), per ws.mts.
    const d = dial(
      `${baseWs}/ws?sid=${validSid}&token=${TOKEN}&lastSeq=not-a-number`,
    );
    const ok = await d.opened;
    expect(ok).toBe(true);
    d.ws.close();
    await d.closed;
  });
});
