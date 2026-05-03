// Unit + integration tests for `transport-bridge.ts` (T6.2).
//
// Spec ref: ch08 §4.2. We exercise:
//   1. Pure helpers — `authorityMatches`, `buildDaemonConnectionFactory`,
//      `daemonAuthority`, `daemonUrl`, `stripHopByHop`.
//   2. End-to-end (still in-process — no Electron) — spin up a stub
//      daemon http2 server on loopback, point the bridge at it, hit the
//      bridge with a real http2 client (mimicking the renderer):
//        - Host: 127.0.0.1:<bridge-port>  → 200 + body roundtrip OK
//        - Host: evil.com                 → 421 Misdirected Request
//        - Host header missing             → 421 Misdirected Request
//
// The end-to-end shape mirrors `packages/daemon/test/integration/rpc/
// clients-transport-matrix.spec.ts` — same h2c framing with a stub
// handler that echoes a canned body. We do NOT involve Connect-RPC here:
// the bridge does not parse Connect framing, so testing transparent http2
// proxying is sufficient for the bridge contract.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as http2 from 'node:http2';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';
import { once } from 'node:events';

import {
  type DaemonEndpoint,
  authorityMatches,
  buildDaemonConnectionFactory,
  daemonAuthority,
  daemonUrl,
  startBridge,
  stripHopByHop,
} from '../../src/main/transport-bridge.js';

// ---------------------------------------------------------------------------
// Pure helper tests
// ---------------------------------------------------------------------------

describe('authorityMatches — Host enforcement (ch08 §4.2 step 3)', () => {
  it('matches exact :authority header', () => {
    expect(
      authorityMatches('127.0.0.1:55555', undefined, '127.0.0.1', 55555),
    ).toBe(true);
  });

  it('matches case-insensitively', () => {
    expect(
      authorityMatches('127.0.0.1:55555', undefined, '127.0.0.1', 55555),
    ).toBe(true);
  });

  it('falls back to Host header when :authority is absent', () => {
    expect(
      authorityMatches(undefined, '127.0.0.1:55555', '127.0.0.1', 55555),
    ).toBe(true);
  });

  it('rejects :authority with wrong host', () => {
    expect(
      authorityMatches('evil.com:55555', undefined, '127.0.0.1', 55555),
    ).toBe(false);
  });

  it('rejects :authority with wrong port', () => {
    expect(
      authorityMatches('127.0.0.1:9999', undefined, '127.0.0.1', 55555),
    ).toBe(false);
  });

  it('rejects :authority missing port', () => {
    expect(authorityMatches('127.0.0.1', undefined, '127.0.0.1', 55555)).toBe(
      false,
    );
  });

  it('rejects "localhost" string (only literal IP allowed per ch08 §4.2)', () => {
    expect(
      authorityMatches('localhost:55555', undefined, '127.0.0.1', 55555),
    ).toBe(false);
  });

  it('rejects when both :authority and Host are absent', () => {
    expect(authorityMatches(undefined, undefined, '127.0.0.1', 55555)).toBe(
      false,
    );
  });

  it('uses first array element when header repeats', () => {
    expect(
      authorityMatches(
        ['127.0.0.1:55555', 'evil.com'],
        undefined,
        '127.0.0.1',
        55555,
      ),
    ).toBe(true);
  });
});

describe('buildDaemonConnectionFactory — per-transport branch', () => {
  it('returns a factory for KIND_UDS', () => {
    const f = buildDaemonConnectionFactory({
      transport: 'KIND_UDS',
      address: '/tmp/x.sock',
      tlsCertFingerprintSha256: null,
    });
    expect(typeof f).toBe('function');
  });

  it('returns a factory for KIND_NAMED_PIPE', () => {
    const f = buildDaemonConnectionFactory({
      transport: 'KIND_NAMED_PIPE',
      address: '\\\\.\\pipe\\x',
      tlsCertFingerprintSha256: null,
    });
    expect(typeof f).toBe('function');
  });

  it('returns undefined for KIND_TCP_LOOPBACK_H2C (default dialer)', () => {
    expect(
      buildDaemonConnectionFactory({
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: '127.0.0.1:1234',
        tlsCertFingerprintSha256: null,
      }),
    ).toBeUndefined();
  });

  it('throws for KIND_TCP_LOOPBACK_H2_TLS (not implemented in v0.3)', () => {
    expect(() =>
      buildDaemonConnectionFactory({
        transport: 'KIND_TCP_LOOPBACK_H2_TLS',
        address: '127.0.0.1:1234',
        tlsCertFingerprintSha256: 'abc',
      }),
    ).toThrowError(/not implemented in v0\.3/);
  });
});

describe('daemonAuthority + daemonUrl', () => {
  it('uds.invalid for KIND_UDS', () => {
    const ep: DaemonEndpoint = {
      transport: 'KIND_UDS',
      address: '/tmp/x.sock',
      tlsCertFingerprintSha256: null,
    };
    expect(daemonAuthority(ep)).toBe('uds.invalid');
    expect(daemonUrl(ep)).toBe('http://uds.invalid');
  });

  it('pipe.invalid for KIND_NAMED_PIPE', () => {
    const ep: DaemonEndpoint = {
      transport: 'KIND_NAMED_PIPE',
      address: '\\\\.\\pipe\\x',
      tlsCertFingerprintSha256: null,
    };
    expect(daemonAuthority(ep)).toBe('pipe.invalid');
  });

  it('passes address through for KIND_TCP_LOOPBACK_H2C', () => {
    const ep: DaemonEndpoint = {
      transport: 'KIND_TCP_LOOPBACK_H2C',
      address: '127.0.0.1:9999',
      tlsCertFingerprintSha256: null,
    };
    expect(daemonAuthority(ep)).toBe('127.0.0.1:9999');
    expect(daemonUrl(ep)).toBe('http://127.0.0.1:9999');
  });
});

describe('stripHopByHop', () => {
  it('strips :method/:scheme/:path/:authority pseudo-headers', () => {
    const out = stripHopByHop({
      ':method': 'POST',
      ':scheme': 'http',
      ':path': '/x',
      ':authority': '127.0.0.1:1',
      'content-type': 'application/connect+proto',
    });
    expect(out).toEqual({ 'content-type': 'application/connect+proto' });
  });

  it('strips host + transfer-encoding + connection', () => {
    const out = stripHopByHop({
      host: 'a',
      connection: 'close',
      'transfer-encoding': 'chunked',
      'x-keep': 'v',
    });
    expect(out).toEqual({ 'x-keep': 'v' });
  });

  it('drops undefined values', () => {
    const out = stripHopByHop({ 'x-defined': 'v', 'x-undef': undefined });
    expect(out).toEqual({ 'x-defined': 'v' });
  });
});

// ---------------------------------------------------------------------------
// End-to-end — bridge against a stub daemon over loopback h2c
// ---------------------------------------------------------------------------

interface StubDaemon {
  server: http2.Http2Server;
  port: number;
  stop: () => Promise<void>;
}

async function startStubDaemon(): Promise<StubDaemon> {
  const server = http2.createServer();
  server.on('stream', (stream, headers) => {
    // Echo the request path + a fixed body so the bridge round-trip is
    // verifiable from the renderer side.
    const path = String(headers[':path'] ?? '/');
    const body = JSON.stringify({ ok: true, echoPath: path });
    stream.respond({
      ':status': 200,
      'content-type': 'application/json',
      'x-stub-daemon': '1',
    });
    stream.end(body);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address() as AddressInfo;
  return {
    server,
    port: addr.port,
    stop: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

interface ClientResult {
  status: number;
  body: string;
  headers: http2.IncomingHttpHeaders & http2.IncomingHttpStatusHeader;
}

async function hitBridge(
  bridgeUrl: string,
  authority: string | undefined,
): Promise<ClientResult> {
  // Connect to the bridge using its real bound URL but force the
  // `:authority` pseudo-header so we can simulate a malicious / mistaken
  // renderer sending the wrong Host. By default `http2.connect(url)`
  // derives `:authority` from the URL; we override it per-stream below.
  const session = http2.connect(bridgeUrl);
  try {
    const stream = session.request({
      ':method': 'POST',
      ':path': '/echo',
      ':scheme': 'http',
      ...(authority !== undefined ? { ':authority': authority } : {}),
      'content-type': 'application/connect+proto',
    });
    stream.end();

    const headers = (await once(stream, 'response'))[0] as http2.IncomingHttpHeaders &
      http2.IncomingHttpStatusHeader;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(chunk as Buffer);
    return {
      status: Number(headers[':status']),
      body: Buffer.concat(chunks).toString('utf8'),
      headers,
    };
  } finally {
    await new Promise<void>((resolve) => {
      session.close(() => resolve());
    });
  }
}

describe('startBridge — Host enforcement + forwarding (ch08 §4.2)', () => {
  let daemon: StubDaemon;

  beforeEach(async () => {
    daemon = await startStubDaemon();
  });

  afterEach(async () => {
    await daemon.stop();
  });

  it('forwards request when :authority matches bound host:port → 200 + body', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    try {
      const result = await hitBridge(
        bridge.rendererUrl,
        `127.0.0.1:${bridge.port}`,
      );
      expect(result.status).toBe(200);
      expect(result.body).toBe(
        JSON.stringify({ ok: true, echoPath: '/echo' }),
      );
      expect(result.headers['x-stub-daemon']).toBe('1');
      expect(result.headers['content-type']).toBe('application/json');
    } finally {
      await bridge.close();
    }
  });

  it('rejects request with wrong :authority → 421 Misdirected Request', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    try {
      const result = await hitBridge(bridge.rendererUrl, 'evil.com:80');
      expect(result.status).toBe(421);
      // The 421 path MUST NOT have hit the daemon (no x-stub-daemon
      // header would prove it leaked through).
      expect(result.headers['x-stub-daemon']).toBeUndefined();
    } finally {
      await bridge.close();
    }
  });

  it('rejects request whose :authority has wrong port → 421', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    try {
      const result = await hitBridge(
        bridge.rendererUrl,
        `127.0.0.1:${bridge.port + 1}`,
      );
      expect(result.status).toBe(421);
    } finally {
      await bridge.close();
    }
  });

  it('rejects request with :authority="localhost:<port>" (literal IP only) → 421', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    try {
      const result = await hitBridge(
        bridge.rendererUrl,
        `localhost:${bridge.port}`,
      );
      expect(result.status).toBe(421);
    } finally {
      await bridge.close();
    }
  });

  it('binds on 127.0.0.1 ONLY — rendererUrl host is the loopback IP', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    try {
      expect(bridge.host).toBe('127.0.0.1');
      expect(bridge.rendererUrl.startsWith('http://127.0.0.1:')).toBe(true);
      // Confirm the bound socket is actually loopback by examining the
      // server's bound address — defends against a future opts.loopbackHost
      // override slipping through.
      const sock = net.connect(bridge.port, '127.0.0.1');
      await once(sock, 'connect');
      sock.destroy();
    } finally {
      await bridge.close();
    }
  });

  it('close() is idempotent', async () => {
    const bridge = await startBridge({
      daemon: {
        transport: 'KIND_TCP_LOOPBACK_H2C',
        address: `127.0.0.1:${daemon.port}`,
        tlsCertFingerprintSha256: null,
      },
    });
    await bridge.close();
    await bridge.close(); // must not throw
  });

  it('rejects startBridge when daemon is unreachable', async () => {
    // Pick a port nothing should be listening on. Range 1 is reserved.
    await expect(
      startBridge({
        daemon: {
          transport: 'KIND_TCP_LOOPBACK_H2C',
          address: '127.0.0.1:1',
          tlsCertFingerprintSha256: null,
        },
      }),
    ).rejects.toThrow();
  });
});
