// T07 — transport client helpers for parity cases.
//
// Spec: docs/superpowers/specs/2026-05-01-v0.4-web-design.md
//   - ch02 §1   (Connect over HTTP/2)
//   - ch02 §6   (data socket = HTTP/2; control socket stays envelope)
//   - ch03 §7.1 (parity cases pair v0.3 envelope vs v0.4 Connect)
//   - ch08 §3   (L2 contract tests use a real Connect client over the
//                ephemeral data socket — same pattern reused here)
//
// State of the world at T07 (per task brief):
//   - T05 (PR #752) merged: `createConnectDataServer` exists at
//     `daemon/src/connect/server.ts`, dormant — no service handlers, no
//     listener wiring on the data socket. T05.1 will wire it; until then
//     callers boot their own Connect server in tests.
//   - T06 (next PR) registers Ping + GetVersion handlers, builds the
//     `electron/connect/ipc-transport.ts` client. Once T06 lands, the
//     `connectClient(...)` factory below grows a code path that uses the
//     T06 transport directly; until then it returns the bare HTTP/2 unary
//     client, sufficient for any Connect handler T07's placeholder needs.
//
// Single Responsibility:
//   - PRODUCER of clients (envelope + Connect). Knows about wire shapes only
//     enough to construct the right transport. Does NOT decide equivalence
//     (framework.ts), does NOT own daemon lifecycle (test files own that
//     via vitest beforeAll/afterAll).

import { createConnectTransport } from '@connectrpc/connect-node';
import type { Transport } from '@connectrpc/connect';

// ---------------------------------------------------------------------------
// Envelope client (v0.3 path)
// ---------------------------------------------------------------------------

/**
 * Result of one envelope RPC call: the parsed JSON header plus the trailing
 * binary payload (empty for pure-JSON RPCs). Mirrors the shape that
 * `daemon/src/envelope/envelope.ts` decoders produce so test authors can
 * assert against the same structure used by the production daemon code.
 */
export interface EnvelopeResponse<TJson = unknown> {
  readonly header: TJson;
  readonly payload: Buffer;
}

/**
 * Envelope client signature. Test authors call it with the v0.3 method name
 * (e.g. `'daemon.ping'`) and request body; it returns the response envelope.
 *
 * T07 ships the SHAPE of this helper but does NOT bind a concrete
 * implementation: the v0.3 envelope sender lives inside the daemon test
 * harness which is currently in flux (T12/T19 wave). Tests that need a real
 * envelope round-trip should construct their own sender against the daemon
 * fixture they boot in beforeAll, then pass it as the `envelopeCall` in
 * `runParityCase`. M2 bridge-swap PRs (T09 onwards) will refactor this into
 * a concrete `envelopeClient(socketPath)` factory once the daemon test
 * harness stabilizes — placing that refactor here in T07 would prematurely
 * lock the surface to a moving target.
 */
export type EnvelopeClient = (
  method: string,
  body: unknown,
) => Promise<EnvelopeResponse>;

/**
 * Stub envelope client — returns the supplied `staticResponse`. Useful for
 * the placeholder parity case (`tests/parity/ping.parity.test.ts`) and for
 * unit tests of the framework itself. Real envelope clients land alongside
 * the first real bridge swap (T06 + T09).
 */
export function stubEnvelopeClient(
  staticResponses: Record<string, EnvelopeResponse>,
): EnvelopeClient {
  return async (method) => {
    const r = staticResponses[method];
    if (r === undefined) {
      throw new Error(`stubEnvelopeClient: no stub registered for method ${method}`);
    }
    return r;
  };
}

// ---------------------------------------------------------------------------
// Connect client (v0.4 path)
// ---------------------------------------------------------------------------

/**
 * Build a Connect transport pointing at a daemon Connect server bound on a
 * loopback HTTP/2 endpoint. `baseUrl` is the `http://127.0.0.1:<port>` form
 * returned by `createConnectDataServer.listen({ host, port: 0 })`.
 *
 * Uses HTTP/2 cleartext (`http2: true`) per ch02 §6 — the daemon's data
 * socket runs HTTP/2 over the loopback transport (Unix socket / named pipe
 * / dev TCP). TLS termination is the cloudflared edge's job (ch05), not the
 * daemon's.
 *
 * Note on Unix socket / named pipe transport: `@connectrpc/connect-node`'s
 * `createConnectTransport` accepts a `nodeOptions.socketPath`-style escape
 * via the underlying `http2.connect` options. T05.1 will land the canonical
 * socket-path wiring; until then tests bind the Connect server to an
 * ephemeral loopback port (per `createConnectDataServer.listen`) and connect
 * over TCP. That matches the `daemon/src/connect/__tests__/server.test.ts`
 * pattern landed in T05.
 */
export function createConnectTransportForDaemon(opts: {
  /** e.g. `http://127.0.0.1:54321` */
  readonly baseUrl: string;
}): Transport {
  return createConnectTransport({
    baseUrl: opts.baseUrl,
    httpVersion: '2',
  });
}
