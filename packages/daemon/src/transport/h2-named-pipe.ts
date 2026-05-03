// h2 over Windows named pipe — spec ch03 §4 option A4.
//
// Preferred Listener A transport on Windows when MUST-SPIKE
// [win-h2-named-pipe] passes (it has — see
// tools/spike-harness/probes/win-h2-named-pipe). Idiomatic Windows
// path: `LocalService` daemon binds `\\.\pipe\ccsm-<sid>` with a DACL
// allowing the per-user Electron to connect, and the per-pipe peer SID
// (resolved by T1.7 via `ImpersonateNamedPipeClient`) is the authn
// boundary.
//
// Why a `net.Server` bridge instead of `http2.createServer().listen(pipe)`:
// Node's libuv pipe accept surface yields `net.Socket` Duplexes, but
// `http2.createServer().listen(pipe)` historically emits stream-state
// errors on Windows pipes when the peer closes uncleanly (the spike
// reproduces this). The bridge pattern — dedicate a `net.Server` to
// the pipe and `emit('connection', socket)` into the http2 server —
// keeps the http2 layer ignorant of the underlying transport surface,
// matching spike `win-h2-named-pipe/server.mjs` 1:1.
//
// Adapter contract: rejects non-win32 calls (the factory MUST route
// other OSes to `h2c-uds`). Normalizes the pipe name (accepts bare
// name, `\\.\pipe\<name>`, or `\\?\pipe\<name>`) to the `\\?\pipe\`
// form Node + libuv expect.
//
// DACL handling: NOT this adapter's job. The factory / installer sets
// the pipe DACL (T1.4 / T7.5); this adapter is the bind primitive.
//
// Layer 1: node: stdlib only (`node:net`, `node:os`).

import { createServer as createNetServer, type Server as NetServer } from 'node:net';
import { platform } from 'node:os';

import type {
  BoundAddress,
  BoundTransport,
  H2cServer,
  NamedPipeBindSpec,
} from './types.js';

/** Normalize a pipe name to `\\?\pipe\<name>`. Accepts bare names and
 *  the two prefix forms. Per spike `win-h2-named-pipe/server.mjs`. */
export function normalizePipePath(input: string): string {
  if (input.startsWith('\\\\?\\pipe\\') || input.startsWith('\\\\.\\pipe\\')) {
    return input;
  }
  return `\\\\?\\pipe\\${input}`;
}

/**
 * Bind the supplied http2 server to a Windows named pipe via a
 * dedicated `net.Server` bridge. Resolves once the bridge is
 * `listening`.
 *
 * Throws synchronously on non-win32 — the factory MUST route to
 * `bindH2cUds` instead.
 */
export async function bindH2NamedPipe(
  server: H2cServer,
  spec: NamedPipeBindSpec,
): Promise<BoundTransport> {
  if (platform() !== 'win32') {
    throw new Error(
      'h2-named-pipe transport is win32-only; POSIX must use h2c-UDS (spec ch03 §4 A1).',
    );
  }

  const pipePath = normalizePipePath(spec.pipeName);

  // Bridge: every accepted pipe socket is forwarded to the http2
  // server as a `connection` event. The http2 server then drives the
  // SETTINGS frame exchange + multiplexing on the Duplex surface,
  // identically to the UDS / loopback paths.
  const bridge: NetServer = createNetServer((sock) => {
    server.emit('connection', sock);
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      bridge.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      bridge.removeListener('error', onError);
      resolve();
    };
    bridge.once('error', onError);
    bridge.once('listening', onListening);
    bridge.listen(pipePath);
  });

  const address = (): BoundAddress => ({ kind: 'namedPipe', pipeName: pipePath });

  let closed = false;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = new Promise<void>((resolve, reject) => {
      // Close the BRIDGE (the only thing we own that holds the pipe
      // handle). The http2 server was never `listen()`ed directly —
      // we feed it sockets via `emit('connection')` — so calling
      // `server.close()` would throw `Server is not running`. The
      // http2 sessions ride on the bridged Duplex sockets and end
      // when those sockets end.
      bridge.close((bridgeErr) => {
        if (bridgeErr) reject(bridgeErr);
        else resolve();
      });
    });
    return closePromise;
  };

  return { address, close };
}
