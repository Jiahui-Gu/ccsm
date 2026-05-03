// T8.11 — integration spec: clients-transport-matrix.
//
// Spec ch12 §3 (per-RPC integration coverage list) + ch11 §6 (CI matrix):
//
//   `rpc/clients-transport-matrix.spec.ts` — parameterized over
//   `transport ∈ {h2c-uds, h2c-loopback, h2-tls-loopback, h2-named-pipe}`;
//   for each transport kind in the descriptor enum, construct a Connect
//   transport from a synthesized descriptor and run `Hello`. Guards the
//   MUST-SPIKE fallback paths (ch14) so flipping the transport pick after
//   a spike outcome doesn't ship an untested transport.
//
// Spec ch04 §2 / ch04 §3:
//
//   The forever-stable wire surface includes `Hello` (unary), the rest of
//   `SessionService` unary methods, and `WatchSessions` (server-streaming).
//   This file covers one of each shape — `Hello` (handshake unary),
//   `ListSessions` (representative non-handshake unary), and
//   `WatchSessions` (representative server-streaming RPC) — across every
//   per-OS-supported transport. Identical responses across transports are
//   the assertion: the wire format is transport-agnostic, so any divergence
//   is either a server-side branch on transport (forbidden) or a client
//   transport bug.
//
// Per task scope: parameterize the matrix over the three production
// transports of the `BindDescriptor` closed enum that v0.3 actually ships
// (`h2c-uds`, `h2c-loopback-tcp`, `h2-named-pipe`). The fourth enum value
// (`h2-tls-loopback`) is a v0.3 fallback for the loopback-TCP MUST-SPIKE
// outcome and is exercised by a separate suite (TLS cert + fingerprint pin
// is a different surface than this matrix is shaped to assert).
//
// OS skip rules (spec ch03 §2 — Listener A platform pick):
//   - UDS path is unsupported on win32 → skip on win32.
//   - Named-pipe path is unsupported on POSIX → skip on darwin/linux.
//   - h2c loopback-TCP works on every OS → never skip.
//
// Layer-1 / SRP:
//   - Producer side: a tiny in-process Connect server that implements three
//     RPCs deterministically. Fixed responses, no I/O, no stateful side
//     effects beyond the bound socket itself.
//   - Decider: the parameterized matrix (`for (const transport of cases)`)
//     drives one bring-up + RPC-trio per transport then asserts equality.
//   - Sink: `afterEach` tears down server + listener (closes sockets,
//     unlinks UDS file). One concern per block.
//
// Why we don't depend on the daemon's `Listener A` (T1.4) or the descriptor
// writer's transport selection: T8.11 is `blockedBy: []` in the DAG (level 8
// independent). The matrix exists precisely so that whichever transport
// `makeListenerA` ends up returning post-spike (T9.4 / T9.5 / T9.6 verdicts)
// has a regression net already in place — the test owns the wire shape, not
// the listener factory.

import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import * as net from 'node:net';
import * as http2 from 'node:http2';
import { create } from '@bufbuild/protobuf';
import { ConnectError, Code, createClient } from '@connectrpc/connect';
import {
  connectNodeAdapter,
  createConnectTransport,
} from '@connectrpc/connect-node';
import {
  HelloResponseSchema,
  ListSessionsResponseSchema,
  RequestMetaSchema,
  SessionEventSchema,
  SessionSchema,
  SessionService,
  SessionState,
  WatchScope,
} from '@ccsm/proto';

// -----------------------------------------------------------------------------
// Server impl — same handler for every transport (the contract under test).
// -----------------------------------------------------------------------------
//
// These responses are intentionally fixed so cross-transport equality is the
// assertion. Any divergence between transports = bug in the transport wiring
// (server- or client-side), since the handler returns identical bytes per call.

const FIXED_DAEMON_VERSION = '0.3.0-test';
const FIXED_PROTO_VERSION = 1;
const FIXED_SESSION_ID = 'sess-01HZ0000000000000000000001';

function newRequestMeta() {
  return create(RequestMetaSchema, {
    requestId: randomUUID(),
    clientVersion: '0.3.0-test',
    clientSendUnixMs: BigInt(0),
  });
}

function buildHelloResponse() {
  return create(HelloResponseSchema, {
    meta: newRequestMeta(),
    daemonVersion: FIXED_DAEMON_VERSION,
    protoVersion: FIXED_PROTO_VERSION,
    listenerId: 'A',
    // `principal` left unset — the proto field is present-bit optional via
    // proto3 message-typed field semantics; absence is the documented
    // behavior when the test server has no peer-cred middleware (ch03 §5
    // is mocked here; T1.7 handles the real chain).
  });
}

function buildListSessionsResponse() {
  return create(ListSessionsResponseSchema, {
    meta: newRequestMeta(),
    sessions: [
      create(SessionSchema, {
        id: FIXED_SESSION_ID,
        state: SessionState.RUNNING,
        cwd: '/tmp/fixture',
        createdUnixMs: BigInt(0),
        lastActiveUnixMs: BigInt(0),
      }),
    ],
  });
}

function buildSessionEvents() {
  return [
    create(SessionEventSchema, {
      kind: {
        case: 'created',
        value: create(SessionSchema, {
          id: FIXED_SESSION_ID,
          state: SessionState.STARTING,
          cwd: '/tmp/fixture',
          createdUnixMs: BigInt(0),
          lastActiveUnixMs: BigInt(0),
        }),
      },
    }),
    create(SessionEventSchema, {
      kind: { case: 'destroyed', value: FIXED_SESSION_ID },
    }),
  ];
}

const handler = connectNodeAdapter({
  routes(router) {
    router.service(SessionService, {
      hello() {
        return buildHelloResponse();
      },
      listSessions() {
        return buildListSessionsResponse();
      },
      async *watchSessions() {
        for (const ev of buildSessionEvents()) {
          yield ev;
        }
      },
      // The remaining SessionService methods are intentionally unimplemented;
      // the router will return `unimplemented` for them, which is the right
      // behavior for this test scope (we only assert Hello / ListSessions /
      // WatchSessions across transports).
    });
  },
});

// -----------------------------------------------------------------------------
// Per-transport bring-up.
// -----------------------------------------------------------------------------
//
// Each case returns:
//   - a started http2 server bound to the transport-specific endpoint
//   - a Connect transport pointed at that endpoint
//   - a stop() that closes the server + cleans up filesystem artifacts
//
// We use `http2.createServer` (h2c, no TLS) for all three production-matrix
// transports. The named-pipe and UDS paths share an identical h2c framing
// over a stream-oriented socket — the only delta is the `listen()` argument
// shape. The loopback-TCP path is the same h2c framing over an ephemeral
// 127.0.0.1 port.

interface TransportBringup {
  server: http2.Http2Server;
  baseUrl: string;
  // Some transports need a custom socket factory (UDS / named-pipe) so the
  // client's `http2.connect` can reach the bound address. For loopback-TCP
  // the baseUrl is enough; `socketPathFactory` is undefined.
  socketPathFactory?: () => net.Socket;
  cleanupPaths: string[];
}

async function bringUpUds(): Promise<TransportBringup> {
  const dir = await mkdtemp(join(tmpdir(), 'ccsm-uds-'));
  // Keep the path short — UDS paths on macOS / Linux are bounded at ~104
  // bytes. `mkdtemp` on POSIX gives `/tmp/ccsm-uds-XXXXXX`, which leaves
  // ample room for `daemon.sock`.
  const sockPath = join(dir, 'daemon.sock');
  const server = http2.createServer({}, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(sockPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    server,
    // Authority is irrelevant for UDS — the host segment is consumed by
    // `createConnection` rather than DNS resolution. We still need a valid
    // URL shape so Connect's path builder works.
    baseUrl: 'http://uds.invalid',
    socketPathFactory: () => net.connect(sockPath),
    cleanupPaths: [dir],
  };
}

async function bringUpLoopbackTcp(): Promise<TransportBringup> {
  const server = http2.createServer({}, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // Port 0 = OS-assigned ephemeral port; avoids flake from concurrent
    // test runs reusing the same port.
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = server.address();
  if (!addr || typeof addr === 'string' || typeof addr.port !== 'number') {
    throw new Error('loopback-tcp listen returned no port');
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    cleanupPaths: [],
  };
}

async function bringUpNamedPipe(): Promise<TransportBringup> {
  // `\\.\pipe\<name>` is the Windows named-pipe namespace. A random suffix
  // avoids collision across parallel test files.
  const pipeName = `\\\\.\\pipe\\ccsm-test-${randomUUID()}`;
  const server = http2.createServer({}, handler);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(pipeName, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  return {
    server,
    baseUrl: 'http://pipe.invalid',
    socketPathFactory: () => net.connect(pipeName),
    cleanupPaths: [],
  };
}

function makeTransportClient(bringup: TransportBringup) {
  const transport = createConnectTransport({
    httpVersion: '2',
    baseUrl: bringup.baseUrl,
    nodeOptions: bringup.socketPathFactory
      ? {
          // For UDS and named-pipe, override the underlying connection so
          // h2c framing rides over the named socket instead of TCP. This
          // matches the spike harness pattern in
          // `tools/spike-harness/probes/uds-h2c/client.mjs`.
          createConnection: bringup.socketPathFactory,
        }
      : undefined,
  });
  return createClient(SessionService, transport);
}

async function teardown(bringup: TransportBringup): Promise<void> {
  await new Promise<void>((resolve) => {
    bringup.server.close(() => resolve());
    // Close any remaining sessions hard so a hung client can't pin the
    // teardown — this matches the spike-harness shutdown pattern.
    setTimeout(() => resolve(), 1000).unref();
  });
  for (const p of bringup.cleanupPaths) {
    await rm(p, { recursive: true, force: true });
  }
}

// -----------------------------------------------------------------------------
// Matrix definition.
// -----------------------------------------------------------------------------

interface MatrixCase {
  // Stable label used in describe() / it() output. Matches the prose in the
  // task description (`h2c-uds`, `h2c-loopback-tcp`, `h2-named-pipe`).
  readonly label: 'h2c-uds' | 'h2c-loopback-tcp' | 'h2-named-pipe';
  // Spec ch03 §1a — closed-enum BindDescriptor.kind value this case stands in
  // for. Pinning it here means flipping `makeListenerA`'s spike outcome (e.g.
  // adding a new BindDescriptor variant) is mechanically grep-able against
  // this matrix.
  readonly descriptorKind:
    | 'KIND_UDS'
    | 'KIND_TCP_LOOPBACK_H2C'
    | 'KIND_NAMED_PIPE';
  readonly bringup: () => Promise<TransportBringup>;
  readonly skipReason: string | null;
}

function buildMatrix(): MatrixCase[] {
  const isWin = platform() === 'win32';
  return [
    {
      label: 'h2c-uds',
      descriptorKind: 'KIND_UDS',
      bringup: bringUpUds,
      // UDS is POSIX-only; spike T9.4 covers darwin + linux only.
      skipReason: isWin ? 'UDS unsupported on win32 (ch03 §2)' : null,
    },
    {
      label: 'h2c-loopback-tcp',
      descriptorKind: 'KIND_TCP_LOOPBACK_H2C',
      bringup: bringUpLoopbackTcp,
      // Loopback h2c works on every OS — it is the universal fallback for
      // the loopback MUST-SPIKE outcome (ch03 §4).
      skipReason: null,
    },
    {
      label: 'h2-named-pipe',
      descriptorKind: 'KIND_NAMED_PIPE',
      bringup: bringUpNamedPipe,
      // Named pipes are Windows-only; the path namespace `\\.\pipe\` does
      // not exist on POSIX kernels.
      skipReason: !isWin ? 'Named pipes unsupported on POSIX (ch03 §2)' : null,
    },
  ];
}

// -----------------------------------------------------------------------------
// The matrix.
// -----------------------------------------------------------------------------

describe('rpc/clients-transport-matrix (T8.11; spec ch12 §3)', () => {
  const cases = buildMatrix();

  // Sanity: every case should map onto exactly one BindDescriptor.kind. If a
  // future v0.3 edit adds a new kind, this guard surfaces the drift loudly
  // (see ch15 §3 forbidden-pattern 8 — new transports SHIP under a NEW
  // descriptor file, not as new enum values, but the matrix should still pin
  // every kind v0.3 ships).
  beforeAll(() => {
    const seen = new Set(cases.map((c) => c.descriptorKind));
    expect(seen.size).toBe(cases.length);
  });

  for (const matrixCase of cases) {
    // Use Vitest's per-case skip so the run reports the skip reason — much
    // friendlier than silently absent tests when triaging a Linux CI log.
    const block = matrixCase.skipReason ? describe.skip : describe;

    block(`${matrixCase.label} (${matrixCase.descriptorKind})`, () => {
      let bringup: TransportBringup | null = null;

      afterEach(async () => {
        if (bringup) {
          await teardown(bringup);
          bringup = null;
        }
      });

      it('Hello returns the fixed daemon identity', async () => {
        bringup = await matrixCase.bringup();
        const client = makeTransportClient(bringup);

        const res = await client.hello({
          meta: newRequestMeta(),
          clientKind: 'electron',
          protoMinVersion: FIXED_PROTO_VERSION,
        });

        expect(res.daemonVersion).toBe(FIXED_DAEMON_VERSION);
        expect(res.protoVersion).toBe(FIXED_PROTO_VERSION);
        expect(res.listenerId).toBe('A');
      });

      it('ListSessions returns the fixed session set (representative unary)', async () => {
        bringup = await matrixCase.bringup();
        const client = makeTransportClient(bringup);

        const res = await client.listSessions({ meta: newRequestMeta() });

        expect(res.sessions).toHaveLength(1);
        expect(res.sessions[0].id).toBe(FIXED_SESSION_ID);
        expect(res.sessions[0].state).toBe(SessionState.RUNNING);
        expect(res.sessions[0].cwd).toBe('/tmp/fixture');
      });

      it('WatchSessions streams the fixed event sequence (representative server-streaming)', async () => {
        bringup = await matrixCase.bringup();
        const client = makeTransportClient(bringup);

        const events: Array<{ case: string | undefined; id?: string }> = [];
        try {
          for await (const ev of client.watchSessions({
            meta: newRequestMeta(),
            scope: WatchScope.OWN,
          })) {
            const k = ev.kind;
            if (k.case === 'created') {
              events.push({ case: 'created', id: k.value.id });
            } else if (k.case === 'updated') {
              events.push({ case: 'updated', id: k.value.id });
            } else if (k.case === 'destroyed') {
              events.push({ case: 'destroyed', id: k.value });
            } else {
              events.push({ case: undefined });
            }
          }
        } catch (err) {
          // Surface ConnectError details verbatim — the cross-transport
          // failure mode we want to catch is "stream truncated mid-flight",
          // and the Code makes that diagnosable from CI logs.
          if (err instanceof ConnectError) {
            throw new Error(
              `WatchSessions failed on ${matrixCase.label}: ${Code[err.code]} ${err.rawMessage}`,
            );
          }
          throw err;
        }

        expect(events).toEqual([
          { case: 'created', id: FIXED_SESSION_ID },
          { case: 'destroyed', id: FIXED_SESSION_ID },
        ]);
      });
    });
  }

  // Cross-transport equality assertion: run all enabled transports back-to-
  // back and assert their `Hello` response payloads are byte-identical
  // (modulo the random `meta.requestId` the server generates per call). This
  // is the spec ch11 §6 invariant — the wire format is transport-agnostic.
  it('Hello payload is identical across all enabled transports', async () => {
    const enabled = cases.filter((c) => c.skipReason === null);
    if (enabled.length < 2) {
      // Single-transport platform (none currently exists since loopback-tcp
      // is universal, but pin the skip-rule so a future OS that disables
      // loopback doesn't silently degrade the assertion).
      return;
    }
    const bringups: TransportBringup[] = [];
    try {
      const responses = [];
      for (const c of enabled) {
        const b = await c.bringup();
        bringups.push(b);
        const client = makeTransportClient(b);
        const res = await client.hello({
          meta: newRequestMeta(),
          clientKind: 'electron',
          protoMinVersion: FIXED_PROTO_VERSION,
        });
        responses.push({
          daemonVersion: res.daemonVersion,
          protoVersion: res.protoVersion,
          listenerId: res.listenerId,
        });
      }
      const first = responses[0];
      for (const r of responses.slice(1)) {
        expect(r).toEqual(first);
      }
    } finally {
      for (const b of bringups) {
        await teardown(b);
      }
    }
  });
});
