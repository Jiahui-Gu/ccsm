// Supervisor server integration tests — bind a real UDS / named-pipe,
// drive it with `http` requests through the same UDS, assert the response
// shapes match the locked goldens. Spec refs:
//   - ch03 §7 endpoints + per-OS bind table.
//   - ch03 §7.1 admin allowlist (deny path).
//   - ch15 §3 forbidden-pattern #9 (golden response shapes).
//
// Cross-platform binding: node's `http.createServer().listen(path)` accepts
// a UDS path on POSIX and a `\\.\pipe\<name>` named-pipe path on Windows
// with no API difference. We pick a per-test address under `os.tmpdir()` /
// `\\.\pipe\ccsm-test-*` and pass it through `config.address`.

import { createServer } from 'node:http';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { Lifecycle, Phase } from '../../lifecycle.js';
import { makeSupervisorServer, type SupervisorServer } from '../server.js';
import {
  defaultAdminAllowlist,
  SID_LOCAL_SERVICE,
  type AdminAllowlist,
} from '../admin-allowlist.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function tempSupervisorAddress(): string {
  const id = randomUUID().slice(0, 8);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\ccsm-test-supervisor-${id}`;
  }
  // Keep the path under 100 chars (sun_path limit on linux is 108, mac 104).
  return path.join(os.tmpdir(), `ccsm-sv-${id}.sock`);
}

interface HttpResp {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly bodyText: string;
}

/**
 * Plain HTTP/1.1 client over the same UDS / named-pipe the supervisor
 * binds. We hand-roll the request rather than pulling in undici because
 * `http.request({ socketPath })` doesn't exist for Windows named-pipes
 * uniformly across node versions; raw socket.write keeps both branches
 * identical. Single shot — no keep-alive, no streaming.
 */
async function uxHttp(
  address: string,
  method: 'GET' | 'POST',
  url: string,
): Promise<HttpResp> {
  return new Promise<HttpResp>((resolve, reject) => {
    const sock = net.createConnection(address);
    let buf = '';
    sock.on('error', reject);
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
    });
    sock.on('end', () => {
      try {
        resolve(parseHttpResponse(buf));
      } catch (err) {
        reject(err);
      }
    });
    sock.on('connect', () => {
      const req =
        `${method} ${url} HTTP/1.1\r\n` +
        `host: localhost\r\n` +
        `connection: close\r\n` +
        `content-length: 0\r\n` +
        `\r\n`;
      sock.write(req);
    });
  });
}

function parseHttpResponse(raw: string): HttpResp {
  const headerEnd = raw.indexOf('\r\n\r\n');
  if (headerEnd < 0) throw new Error(`malformed HTTP response: ${raw}`);
  const headPart = raw.slice(0, headerEnd);
  const bodyText = raw.slice(headerEnd + 4);
  const lines = headPart.split('\r\n');
  const statusLine = lines[0] ?? '';
  const m = /^HTTP\/1\.1 (\d{3}) /.exec(statusLine);
  if (!m) throw new Error(`bad status line: ${statusLine}`);
  const status = Number(m[1]);
  const headers: Record<string, string> = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim().toLowerCase();
      const v = line.slice(idx + 1).trim();
      headers[k] = v;
    }
  }
  return { status, headers, bodyText };
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe('SupervisorServer — UDS / named-pipe bind + endpoints', () => {
  let server: SupervisorServer | null = null;
  let address: string;
  let lifecycle: Lifecycle;
  const bootId = '11111111-2222-3333-4444-555555555555';
  const version = '0.3.0-test';
  const startTimeMs = 1_700_000_000_000;

  // The "current peer" injected lookup returns. Tests mutate this between
  // requests to drive allow vs deny.
  let mockUid = 1000;
  let mockSid = 'S-1-5-21-1111-2222-3333-1001';

  beforeEach(() => {
    address = tempSupervisorAddress();
    lifecycle = new Lifecycle();
  });

  afterEach(async () => {
    if (server) {
      try {
        await server.stop();
      } catch {
        // ignore double-stop in tests
      }
      server = null;
    }
  });

  function build(opts: {
    allowlist?: AdminAllowlist;
    onShutdown?: (graceMs: number) => void;
    nowMs?: number;
  } = {}): SupervisorServer {
    const allowlist =
      opts.allowlist ??
      // Test default: allow uid 999 (POSIX) + LocalService SID (Windows).
      ({ uids: new Set([0, 999]), sids: new Set([SID_LOCAL_SERVICE]) } as AdminAllowlist);
    return makeSupervisorServer({
      lifecycle,
      bootId,
      version,
      startTimeMs,
      adminAllowlist: allowlist,
      address,
      udsLookup: () => ({ uid: mockUid, gid: 100, pid: 4242 }),
      namedPipeLookup: () => ({ sid: mockSid, displayName: '' }),
      now: () => opts.nowMs ?? startTimeMs + 1_000,
      onShutdown: opts.onShutdown ?? (() => {}),
    });
  }

  // -------------------------------------------------------------------------
  // /healthz
  // -------------------------------------------------------------------------

  describe('GET /healthz', () => {
    it('returns 503 with locked-shape body before lifecycle is READY', async () => {
      server = build({ nowMs: startTimeMs + 7_500 });
      await server.start();

      const r = await uxHttp(address, 'GET', '/healthz');
      expect(r.status).toBe(503);
      expect(r.headers['content-type']).toMatch(/application\/json/);
      const body = JSON.parse(r.bodyText) as Record<string, unknown>;
      expect(body).toEqual({
        ready: false,
        version,
        uptimeS: 7,
        boot_id: bootId,
      });
    });

    it('returns 200 with locked-shape body once lifecycle reaches READY (golden match)', async () => {
      server = build({ nowMs: startTimeMs });
      await server.start();
      lifecycle.advanceTo(Phase.LOADING_CONFIG);
      lifecycle.advanceTo(Phase.OPENING_DB);
      lifecycle.advanceTo(Phase.RESTORING_SESSIONS);
      lifecycle.advanceTo(Phase.STARTING_LISTENERS);
      lifecycle.advanceTo(Phase.READY);

      const r = await uxHttp(address, 'GET', '/healthz');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.bodyText) as Record<string, unknown>;
      // Spec ch03 §7 literal: { ready, version, uptimeS, boot_id }
      expect(Object.keys(body).sort()).toEqual(['boot_id', 'ready', 'uptimeS', 'version']);
      expect(body.ready).toBe(true);
      expect(body.version).toBe(version);
      expect(body.boot_id).toBe(bootId);
      expect(typeof body.uptimeS).toBe('number');
      expect(Number.isInteger(body.uptimeS)).toBe(true);
      expect(body.uptimeS).toBeGreaterThanOrEqual(0);
    });

    it('does NOT consult the admin allowlist (any peer may probe)', async () => {
      // Build with an allowlist that excludes mockUid; healthz should still
      // be reachable (spec ch03 §7.1: "/healthz requires no admin check").
      mockUid = 1000;
      server = build({
        allowlist: { uids: new Set([0]), sids: new Set([SID_LOCAL_SERVICE]) },
      });
      await server.start();
      lifecycle.advanceTo(Phase.LOADING_CONFIG);
      lifecycle.advanceTo(Phase.OPENING_DB);
      lifecycle.advanceTo(Phase.RESTORING_SESSIONS);
      lifecycle.advanceTo(Phase.STARTING_LISTENERS);
      lifecycle.advanceTo(Phase.READY);

      const r = await uxHttp(address, 'GET', '/healthz');
      expect(r.status).toBe(200);
    });
  });

  // -------------------------------------------------------------------------
  // /hello — peer-cred allow vs deny
  // -------------------------------------------------------------------------

  describe('POST /hello', () => {
    it('200 + locked body when peer is in the admin allowlist (peer-cred allow)', async () => {
      mockUid = 999;
      mockSid = SID_LOCAL_SERVICE;
      server = build();
      await server.start();

      const r = await uxHttp(address, 'POST', '/hello');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.bodyText) as Record<string, unknown>;
      // SupervisorHelloResponse — { meta, daemon_version, boot_id }
      expect(Object.keys(body).sort()).toEqual(['boot_id', 'daemon_version', 'meta']);
      expect(body.daemon_version).toBe(version);
      expect(body.boot_id).toBe(bootId);
      const meta = body.meta as Record<string, unknown>;
      expect(meta).toEqual({
        request_id: '00000000-0000-0000-0000-000000000000',
        client_version: '0.3.0',
        client_send_unix_ms: 0,
      });
    });

    it('403 with peer-cred-rejected golden shape when peer is NOT in the allowlist', async () => {
      mockUid = 1000; // not in {0, 999}
      mockSid = 'S-1-5-21-9-9-9-1001'; // not LocalService and no membership cb
      server = build();
      await server.start();

      const r = await uxHttp(address, 'POST', '/hello');
      expect(r.status).toBe(403);
      const body = JSON.parse(r.bodyText) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['reason', 'status']);
      expect(body.status).toBe(403);
      expect(body.reason).toBe('peer-cred admin check failed');
    });
  });

  // -------------------------------------------------------------------------
  // /shutdown — admin allowlist deny + accepted-true success
  // -------------------------------------------------------------------------

  describe('POST /shutdown', () => {
    it('403 (peer-cred deny) when caller is not in the admin allowlist', async () => {
      mockUid = 1000;
      mockSid = 'S-1-5-21-9-9-9-1001';
      let shutdownCalled = false;
      server = build({ onShutdown: () => { shutdownCalled = true; } });
      await server.start();

      const r = await uxHttp(address, 'POST', '/shutdown');
      expect(r.status).toBe(403);
      // Wait one tick to confirm the shutdown trigger never fires.
      await new Promise((resolve) => setImmediate(resolve));
      expect(shutdownCalled).toBe(false);
    });

    it('200 + accepted=true + grace_ms=5000, fires onShutdown(5000)', async () => {
      mockUid = 999;
      mockSid = SID_LOCAL_SERVICE;
      let calledWith: number | null = null;
      server = build({ onShutdown: (g) => { calledWith = g; } });
      await server.start();

      const r = await uxHttp(address, 'POST', '/shutdown');
      expect(r.status).toBe(200);
      const body = JSON.parse(r.bodyText) as Record<string, unknown>;
      expect(Object.keys(body).sort()).toEqual(['accepted', 'grace_ms', 'meta']);
      expect(body.accepted).toBe(true);
      expect(body.grace_ms).toBe(5000);
      // onShutdown is invoked via setImmediate; wait one tick.
      await new Promise((resolve) => setImmediate(resolve));
      expect(calledWith).toBe(5000);
    });
  });

  // -------------------------------------------------------------------------
  // 404 for unknown routes / methods
  // -------------------------------------------------------------------------

  it('404s an unknown path', async () => {
    server = build();
    await server.start();
    const r = await uxHttp(address, 'GET', '/nope');
    expect(r.status).toBe(404);
  });

  it('404s the wrong method on a known path (GET /shutdown)', async () => {
    server = build();
    await server.start();
    const r = await uxHttp(address, 'GET', '/shutdown');
    expect(r.status).toBe(404);
  });

  // -------------------------------------------------------------------------
  // start/stop lifecycle
  // -------------------------------------------------------------------------

  it('start() is single-shot — second call throws', async () => {
    server = build();
    await server.start();
    await expect(server.start()).rejects.toThrow(/start\(\) called twice/);
  });

  it('stop() is idempotent', async () => {
    server = build();
    await server.start();
    await server.stop();
    // Second stop must not throw.
    await expect(server.stop()).resolves.toBeUndefined();
  });
});

// Force the imports to count as used even if a future trim removes a
// reference; ensures vitest sees the modules.
void createServer; void defaultAdminAllowlist;
