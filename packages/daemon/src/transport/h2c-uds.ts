// h2c over Unix Domain Socket — spec ch03 §4 option A1.
//
// Default Listener A transport for darwin / linux when MUST-SPIKE
// [uds-h2c-on-darwin-and-linux] passes (it has — see
// tools/spike-harness/probes/uds-h2c). Plaintext h2c is safe over a
// same-UID UDS because the socket itself is OS-level access-controlled
// (mode 0660, group `ccsm` / `_ccsm` per spec ch03 §3 / §7); peer-cred
// (T1.7) is the authn boundary, not TLS.
//
// Adapter contract: takes a pre-built `Http2Server` (the listener layer
// owns server construction + `connectNodeAdapter` wiring), binds it to
// the supplied UDS path, and returns a `BoundTransport` whose
// `address()` returns the resolved `kind: 'uds'` shape. `close()` is
// idempotent and unlinks the socket file on the way out (a stale
// daemon.sock would block the next boot's bind).
//
// Win32 is rejected at runtime — Windows uses the `h2-named-pipe`
// adapter instead. The factory (T1.4) routes by OS; this adapter
// throws if called on the wrong platform so a misrouting bug fails
// loud at boot rather than silently producing an `EAFNOSUPPORT`-style
// libuv error.
//
// Stale-socket policy: if the supplied path already exists as a
// socket file (residue from a crashed prior boot), we unlink it
// before bind. This matches the spike (`uds-h2c/server.mjs`) and the
// LaunchDaemon / systemd convention — the OS supervisor restarts the
// daemon on crash and the new boot must not be blocked by an
// orphan inode. We do NOT unlink anything that is NOT a socket
// (regular files / dirs at the path are a misconfiguration, not
// recoverable here).
//
// Layer 1: node: stdlib only (`node:fs`, `node:net`).

import { existsSync, lstatSync, unlinkSync } from 'node:fs';
import type { ServerHttp2Session } from 'node:http2';
import { platform } from 'node:os';

import type {
  BoundAddress,
  BoundTransport,
  H2cServer,
  UdsBindSpec,
} from './types.js';

/**
 * Bind the supplied http2 server to a UDS at `spec.path`. Resolves once
 * the underlying `net.Server` is `listening`.
 *
 * Throws synchronously on win32 — UDS bind is POSIX-only; the factory
 * MUST route Windows to `h2-named-pipe` instead.
 */
export async function bindH2cUds(
  server: H2cServer,
  spec: UdsBindSpec,
): Promise<BoundTransport> {
  if (platform() === 'win32') {
    throw new Error(
      'h2c-UDS transport is POSIX-only; Windows must use h2-named-pipe (spec ch03 §4 A4).',
    );
  }

  // Stale-socket cleanup. lstat (NOT stat) so a symlink to a regular
  // file does not get clobbered — only an actual socket inode is
  // removable. Anything else is a misconfiguration that should fail
  // loud at the listen() call below.
  if (existsSync(spec.path)) {
    const st = lstatSync(spec.path);
    if (st.isSocket()) {
      unlinkSync(spec.path);
    }
  }

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
    server.listen(spec.path);
  });

  // Track active h2 sessions so `close()` can force-destroy them.
  // `Http2Server.close()` does NOT have an `http.Server.closeAllConnections`
  // analogue (verified against the Node 22 http2 docs); it waits for all
  // sessions to drain. Connect-node clients keep h2 sessions alive, so
  // without an explicit destroy the close callback never fires — surfaced
  // by T0.8 matrix on Linux/macOS where uds keep-alive timing differs
  // from Windows. Spec ch03 §3.2: bound-transport stop is near-immediate,
  // not a graceful drain — the renderer reconnects on its own retry policy.
  const sessions = new Set<ServerHttp2Session>();
  const trackSession = (session: ServerHttp2Session): void => {
    sessions.add(session);
    session.once('close', () => sessions.delete(session));
  };
  server.on('session', trackSession);

  let closed = false;
  let closePromise: Promise<void> | null = null;

  const address = (): BoundAddress => ({ kind: 'uds', path: spec.path });

  const close = async (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = new Promise<void>((resolve, reject) => {
      server.removeListener('session', trackSession);
      // Force-destroy any sessions still alive so `server.close()`'s
      // drain wait completes promptly.
      for (const session of sessions) {
        session.destroy();
      }
      sessions.clear();
      server.close((err) => {
        // Best-effort socket file cleanup. Spec ch03 §3.1 says orphan
        // descriptor FILES between boots are normal; that rule is
        // about `listener-a.json`, not about the socket inode. The
        // bind path itself we do remove because the next boot's
        // `bindH2cUds` would otherwise have to detect + unlink it
        // again — better to leave the FS clean if we shut down
        // cooperatively.
        try {
          if (existsSync(spec.path) && lstatSync(spec.path).isSocket()) {
            unlinkSync(spec.path);
          }
        } catch {
          /* ignore — close() success is what matters */
        }
        if (err) reject(err);
        else resolve();
      });
    });
    return closePromise;
  };

  return { address, close };
}
