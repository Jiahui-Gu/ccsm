// HTTP/2 + ConnectRouter bind hook for Listener A. Spec ch03 §4 + ch04 §3.
//
// T2.2 scope: provide a `BindHook` (the seam exposed by T1.4's
// `makeListenerA`) that constructs a Node `http2.Http2Server` whose
// `request` handler is the Connect router (stub services from
// `./router.ts`), then delegates the OS-level bind to one of the T1.5
// transport adapters based on the resolved `BindDescriptor.kind`.
//
// Why this lives in `rpc/` (not `listeners/` or `transport/`):
//   - `listeners/factory.ts` deliberately knows nothing about HTTP/2 or
//     Connect — the seam (`BindHook`) was added by T1.4 precisely so
//     T2.2 could swap in protocol-aware bind without touching the
//     factory.
//   - `transport/*` adapters take a pre-built `Http2Server` — they know
//     about sockets, not protocols. Constructing the server with the
//     Connect handler attached is a router-layer concern.
//   - This module is the single place that joins the three: router +
//     http2 server + transport adapter. It is the SRP `producer` of a
//     `BoundTransport` from a `BindDescriptor`.
//
// Layer 1 — alternatives checked:
//   - We could pass the router into `makeListenerA` directly and let
//     the factory build the http2 server. Rejected: it would force the
//     listener module to depend on @connectrpc/connect, breaking the
//     T1.4-established boundary that listeners are protocol-agnostic.
//   - `connectNodeAdapter`'s returned function is the canonical bridge
//     from a router callback to a Node-compatible request handler;
//     `http2.createServer({}, handler)` accepts it directly — the
//     handler signature `(req, res) => void` is the same for `http` and
//     `http2` (per Node docs).
//   - `tls` BindDescriptor variant is reserved for v0.4 Listener B
//     (ch03 §1a). v0.3 Listener A NEVER picks `tls` (ch03 §4 transport
//     pick). We throw if asked to bind tls so a misrouting bug fails
//     loud at start() time, matching the policy in
//     `listeners/factory.ts`'s `defaultBindHook`.

import { createServer as createH2cServer, type Http2Server } from 'node:http2';
import { platform } from 'node:os';

import type { BindHook } from '../listeners/factory.js';
import type { BindDescriptor } from '../listeners/types.js';
import {
  bindH2cLoopback,
  bindH2cUds,
  bindH2NamedPipe,
  type BoundTransport as TransportBoundTransport,
} from '../transport/index.js';

import {
  createDaemonNodeAdapter,
  type CreateDaemonNodeAdapterOptions,
} from './router.js';

/**
 * Build a `BindHook` that:
 *   1. Constructs a Node http2 server whose request listener is the
 *      Connect-router stub handler (every v0.3 service registered with
 *      `Unimplemented`-by-default).
 *   2. Delegates the OS-level bind to the right T1.5 adapter for the
 *      planned `BindDescriptor.kind`.
 *   3. Returns a `BoundTransport` whose `descriptor` reflects the
 *      RESOLVED bind shape (loopback ports may be ephemeral) and whose
 *      `stop()` tears down the http2 server (which in turn closes the
 *      OS socket).
 */
export function makeRouterBindHook(
  routerOptions: CreateDaemonNodeAdapterOptions = {},
): BindHook {
  const handler = createDaemonNodeAdapter(routerOptions);

  return async (planned: BindDescriptor) => {
    const server: Http2Server = createH2cServer({}, handler);

    const transportBound = await bindByKind(server, planned);
    const resolved = resolveDescriptor(planned, transportBound);

    return {
      descriptor: resolved,
      stop: async () => {
        await transportBound.close();
      },
    };
  };
}

/**
 * Dispatch to the T1.5 adapter that matches `planned.kind`. Throws on
 * the `tls` variant (v0.4-only) and on a `namedPipe` request when
 * running on a non-Windows platform (the named-pipe adapter handles its
 * own platform guard but the cross-check here keeps the error message
 * consistent across the rpc layer).
 */
async function bindByKind(
  server: Http2Server,
  planned: BindDescriptor,
): Promise<TransportBoundTransport> {
  switch (planned.kind) {
    case 'uds':
      return bindH2cUds(server, { path: planned.path });
    case 'namedPipe':
      if (platform() !== 'win32') {
        throw new Error(
          `namedPipe transport requested on non-Windows platform (${platform()}); ` +
            'spec ch03 §4 A4 — named pipes are Windows-only.',
        );
      }
      return bindH2NamedPipe(server, { pipeName: planned.pipeName });
    case 'loopbackTcp':
      // T1.5's loopback adapter currently constrains host to 127.0.0.1
      // (the closed-enum spec value). v0.4 may add `::1`; until then
      // reject with a clear message rather than passing through and
      // letting the adapter throw with a less-helpful "host MUST be
      // 127.0.0.1" message.
      if (planned.host !== '127.0.0.1') {
        throw new Error(
          `loopbackTcp host '${planned.host}' is reserved for v0.4 ` +
            '(spec ch03 §1a closed enum); v0.3 only binds 127.0.0.1.',
        );
      }
      return bindH2cLoopback(server, { host: '127.0.0.1', port: planned.port });
    case 'tls':
      throw new Error(
        'tls bind not supported by Listener A in v0.3 (reserved for v0.4 ' +
          'Listener B per spec ch03 §1a / §4).',
      );
  }
}

/**
 * Translate the T1.5 `BoundAddress` (the post-bind shape returned by
 * each transport adapter) back into a listener-layer `BindDescriptor`.
 * Necessary because the listener trait's `descriptor()` returns
 * `BindDescriptor` (the closed enum from `listeners/types.ts`), not
 * `BoundAddress` (the closed enum from `transport/types.ts`); the two
 * shapes are deliberately separate (per the SRP comment in
 * `transport/types.ts`) and require an explicit translation here.
 *
 * For `uds` / `namedPipe`, the path is unchanged; for `loopback`, the
 * resolved port may differ from the planned port (kernel-assigned when
 * input is `0`) so we read from the bound address. The `tls` variant is
 * unreachable in v0.3 (rejected upstream).
 */
function resolveDescriptor(
  planned: BindDescriptor,
  bound: TransportBoundTransport,
): BindDescriptor {
  const addr = bound.address();
  switch (addr.kind) {
    case 'uds':
      return { kind: 'uds', path: addr.path };
    case 'namedPipe':
      return { kind: 'namedPipe', pipeName: addr.pipeName };
    case 'loopback':
      return { kind: 'loopbackTcp', host: addr.host, port: addr.port };
    case 'tls':
      // Should never happen — v0.3 doesn't construct TLS for Listener A.
      // If it does, surface the planned descriptor unchanged so the
      // caller sees the (still-wrong) shape rather than a partial.
      return planned;
  }
}
