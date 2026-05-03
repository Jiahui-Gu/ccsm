// h2c over loopback TCP — spec ch03 §4 option A2.
//
// Default Listener A transport for win32 if the named-pipe spike (A4)
// fails, and the universal fallback for darwin / linux if the UDS
// spike (A1) regresses. Plaintext h2c on `127.0.0.1` is safe-ish
// against remote attackers (loopback is not routable) but DNS
// rebinding is a hazard for browser clients — the daemon mitigates by
// checking peer-cred (T1.7) on every accepted connection, not by
// trusting the loopback address.
//
// Spike reference: tools/spike-harness/probes/loopback-h2c-on-25h2 —
// confirmed Win 11 25H2 + Defender Firewall accept loopback h2c with
// no third-party LSP intercept. This adapter mirrors the spike's
// `server.mjs`: bind to `127.0.0.1`, port `0` for ephemeral, surface
// the kernel-assigned port via `address()`.
//
// Adapter contract: synchronous-throw on missing host enforcement
// (MUST be `127.0.0.1` — see types.ts), then async listen. The
// `BoundTransport.address()` reflects the RESOLVED port (post-listen),
// not the requested port — the descriptor writer (T1.6) consumes this
// to populate `listener-a.json` with the actual bound port.
//
// Layer 1: node: stdlib only (`node:net`-derived `address()` parsing).

import type { ServerHttp2Session } from 'node:http2';

import type {
  BoundAddress,
  BoundTransport,
  H2cServer,
  LoopbackBindSpec,
} from './types.js';

/**
 * Bind the supplied http2 server to `spec.host:spec.port`. Resolves
 * once `listening` fires; the resolved address (with kernel-assigned
 * port if `spec.port === 0`) is captured for `address()`.
 */
export async function bindH2cLoopback(
  server: H2cServer,
  spec: LoopbackBindSpec,
): Promise<BoundTransport> {
  // Defensive: the type system already constrains host to '127.0.0.1'
  // but adapters are an OS boundary so we re-check at runtime.
  if (spec.host !== '127.0.0.1') {
    throw new Error(
      `h2c-loopback host MUST be 127.0.0.1 (got ${String(spec.host)}); spec ch03 §1a closed enum.`,
    );
  }
  if (!Number.isInteger(spec.port) || spec.port < 0 || spec.port > 65535) {
    throw new Error(`h2c-loopback port out of range: ${spec.port}`);
  }

  // Track active h2 sessions so `close()` can force-destroy them.
  // `Http2Server.close()` does NOT have an `http.Server.closeAllConnections`
  // analogue (verified against the Node 22 http2 docs); it waits for all
  // sessions to drain. Connect-node clients (used in our integration
  // suite + future renderer / electron clients) keep h2 sessions alive,
  // so without an explicit destroy the close callback never fires.
  // Surfaced by T0.8 matrix on Linux/macOS where tcp keep-alive timing
  // differs from Windows. Spec ch03 §3.2: bound-transport stop is
  // near-immediate, not a graceful drain — the renderer reconnects on
  // its own retry policy.
  const sessions = new Set<ServerHttp2Session>();
  const trackSession = (session: ServerHttp2Session): void => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  };
  server.on('session', trackSession);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: spec.host, port: spec.port });
  });

  // Snapshot the address NOW — once the server is listening the
  // address is stable; reading it lazily from `server.address()` after
  // close() returns null, which would break observability hooks that
  // grab `address()` post-close for logging.
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('http2 server.address() returned unexpected shape after listen');
  }
  const boundPort = addr.port;

  const address = (): BoundAddress => ({
    kind: 'loopback',
    host: '127.0.0.1',
    port: boundPort,
  });

  let closed = false;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = new Promise<void>((resolve, reject) => {
      server.removeListener('session', trackSession);
      // Force-destroy any sessions still alive. `session.destroy()` ends
      // the underlying socket synchronously (next tick) so `close()`'s
      // drain wait completes promptly. We drop the result/error from
      // each destroy because a half-closed session may already be
      // emitting `close` — the only correctness contract is that
      // server.close() resolves.
      for (const session of sessions) {
        session.destroy();
      }
      sessions.clear();
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return closePromise;
  };

  return { address, close };
}
