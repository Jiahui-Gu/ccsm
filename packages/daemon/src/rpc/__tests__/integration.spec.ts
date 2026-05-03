// Over-the-wire integration: bind Listener A on a real http2 socket
// using the T2.2 router bind hook, then call any RPC and assert the
// daemon answers Connect `Unimplemented`.
//
// Transport pick:
//   - POSIX (linux / darwin): h2c-UDS — matches the v0.3 production
//     transport for those OSes (spec ch03 §4 A1).
//   - win32: h2c-loopback — UDS bind is POSIX-only and the named-pipe
//     adapter requires a `\\.\pipe\<name>` setup; loopback is the
//     v0.3 fallback Listener A picks on Windows when the named-pipe
//     spike falls over (spec ch03 §4 A2). It exercises the same
//     `connectNodeAdapter` plumbing.
//
// Why hit `SessionService.Hello` specifically: it is the simplest
// unary RPC in the surface and doubles as a smoke test that the
// Connect protocol is being served (route path
// `/ccsm.v1.SessionService/Hello`). Any other unary would do; Hello
// is documented as forever-stable in spec ch04 §3.
//
// Note on RequestMeta: every call below supplies a valid
// `meta.requestId` because T2.4 (#37) wires the
// `requestMetaInterceptor` into `createDaemonNodeAdapter` — an empty
// meta would now be rejected with `InvalidArgument` BEFORE the router
// reaches its `Unimplemented` stub. The integration test asserts the
// downstream Unimplemented behavior, so it intentionally clears the
// meta-validation gate first.

import { afterEach, describe, expect, it } from 'vitest';
import { Code, ConnectError, createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { mkdtempSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { connect as netConnect } from 'node:net';

import { SessionService } from '@ccsm/proto';

import { makeRouterBindHook } from '../bind.js';
import type { BindDescriptor } from '../../listeners/types.js';

const isWin = platform() === 'win32';

/** A canonical UUIDv4 used for the integration calls — passes
 * `requestMetaInterceptor` so the test can assert the next ring
 * (Unimplemented) rather than tripping on missing meta. */
const VALID_REQUEST_ID = '7f3c1d8e-2b94-4f01-a5c6-d9e8b2a107c4';
const validHello = { meta: { requestId: VALID_REQUEST_ID } } as const;

interface Cleanup {
  closeServer?: () => Promise<void>;
}

let cleanup: Cleanup = {};

afterEach(async () => {
  if (cleanup.closeServer) {
    await cleanup.closeServer();
  }
  cleanup = {};
});

function planUds(): BindDescriptor {
  const dir = mkdtempSync(join(tmpdir(), 'ccsm-router-int-'));
  return { kind: 'uds', path: join(dir, 'daemon.sock') };
}

function planLoopback(): BindDescriptor {
  return { kind: 'loopbackTcp', host: '127.0.0.1', port: 0 };
}

describe('router bind hook — over-the-wire Unimplemented', () => {
  it.skipIf(isWin)('serves Unimplemented via h2c-UDS (POSIX)', async () => {
    const hook = makeRouterBindHook();
    const planned = planUds();
    const bound = await hook(planned);
    cleanup.closeServer = () => bound.stop();

    expect(bound.descriptor.kind).toBe('uds');
    if (bound.descriptor.kind !== 'uds') return; // type narrow

    const transport = createConnectTransport({
      httpVersion: '2',
      baseUrl: 'http://localhost',
      nodeOptions: {
        // Connect over UDS by overriding the socket factory — same
        // pattern used by the daemon's own integration tests
        // (transport/__tests__/h2c-uds.spec.ts).
        createConnection: () => netConnect(bound.descriptor.kind === 'uds' ? bound.descriptor.path : ''),
      },
    });
    const client = createClient(SessionService, transport);

    let captured: unknown = null;
    try {
      await client.hello(validHello);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Unimplemented);
  });

  it('serves Unimplemented via h2c-loopback (cross-platform)', async () => {
    const hook = makeRouterBindHook();
    const planned = planLoopback();
    const bound = await hook(planned);
    cleanup.closeServer = () => bound.stop();

    expect(bound.descriptor.kind).toBe('loopbackTcp');
    if (bound.descriptor.kind !== 'loopbackTcp') return; // type narrow
    const port = bound.descriptor.port;
    expect(port).toBeGreaterThan(0);

    const transport = createConnectTransport({
      httpVersion: '2',
      baseUrl: `http://127.0.0.1:${port}`,
    });
    const client = createClient(SessionService, transport);

    let captured: unknown = null;
    try {
      await client.hello(validHello);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeInstanceOf(ConnectError);
    expect((captured as ConnectError).code).toBe(Code.Unimplemented);
  });

  it('rejects loopback host other than 127.0.0.1 with a clear error', async () => {
    const hook = makeRouterBindHook();
    const planned: BindDescriptor = {
      kind: 'loopbackTcp',
      host: '::1',
      port: 0,
    };
    await expect(hook(planned)).rejects.toThrow(/v0\.4|127\.0\.0\.1/);
  });

  it('rejects tls bind on Listener A (v0.4 reserved)', async () => {
    const hook = makeRouterBindHook();
    const planned: BindDescriptor = {
      kind: 'tls',
      host: '127.0.0.1',
      port: 0,
      certPath: '/nonexistent.crt',
      keyPath: '/nonexistent.key',
    };
    await expect(hook(planned)).rejects.toThrow(/tls bind not supported/);
  });
});
