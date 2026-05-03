// Listener A factory — `makeListenerA(env)` returns a `Listener` that, on
// `start()`, binds the chosen transport (UDS / named-pipe / loopback-TCP).
// Spec ch03 §2 (Listener A instantiation) + §4 (transport pick).
//
// SRP layering — three roles, kept separate:
//   - decider: `pickTransportForListenerA(env, platform)` (transport-pick.ts)
//     returns a `BindDescriptor`. Pure.
//   - sink: `defaultBindHook` (this file) calls `net.Server.listen()` once.
//     Single I/O surface.
//   - producer: `makeListenerA` returns the `Listener` trait shape (T1.2).
//     The trait's `descriptor()` method is the producer of the resolved
//     `BindDescriptor` (post-`start()`, with the ephemeral loopback port
//     filled in).
//
// Layer 1 — alternatives checked:
//   - The `Listener` trait shape is FIXED by T1.2 (PR #860 merged); we
//     fill it, we do NOT redesign. `start(): Promise<void>` and
//     `stop(): Promise<void>` stay parameter-less; the `(router)`-shaped
//     start signature in spec ch03 §1 is the v0.4-friendly future shape
//     that T1.5 (HTTP/2 transport adapter) will introduce when it
//     attaches the actual Connect router on top of this socket. T1.4's
//     scope ends at the bound `net.Server`.
//   - `node:net` (`net.createServer().listen({ path }|{ port, host })`)
//     is the standard library primitive for both UDS and TCP. No need
//     for a third-party socket lib.
//   - We do NOT re-export the `BindDescriptor` here — it lives in
//     `./types.ts`. Re-exporting would multiply the import surface and
//     make `grep` for "where is BindDescriptor defined?" ambiguous.
//
// What this file is NOT:
//   - HTTP/2 server attach (that's T1.5).
//   - Connect-RPC router wiring (T1.5 + T2.x).
//   - peer-cred middleware install (T1.3 ships the interceptor; T1.5
//     attaches it to the http2 server).
//   - Descriptor file write (T1.6 / `descriptor.ts` already shipped).
//
// We DO publish a `BindHook` injection seam so T1.5 can swap the plain
// `net.Server` bind for an `http2.createServer({createConnection})`
// without re-shaping this factory.

import { createServer, type Server } from 'node:net';
import { unlink, stat } from 'node:fs/promises';
import type { DaemonEnv } from '../env.js';
import { pickTransportForListenerA, type NodePlatform } from './transport-pick.js';
import type { BindDescriptor, Listener } from './types.js';

/** Stable id for Listener A, recorded in logs and the descriptor file. */
export const LISTENER_A_ID = 'listener-a' as const;

/**
 * Result of a successful bind. The factory's `descriptor()` reads from
 * this — for `loopbackTcp` the `port` may differ from the input pick
 * (the OS assigns when input is `0`).
 *
 * Plain shape (no `Listener` discriminator) so `BindHook` callers stay
 * unaware of the trait vocabulary; this is the *sink*'s output, not the
 * *producer*'s.
 */
export interface BoundTransport {
  /** The resolved bind descriptor (loopback port is filled in here). */
  readonly descriptor: BindDescriptor;
  /** Tear down the bound transport. Idempotent — safe to call twice. */
  stop(): Promise<void>;
}

/**
 * The bind seam. Default implementation (`defaultBindHook`) opens a
 * plain `net.Server`; T1.5 injects an http2-aware variant when it
 * lands. Returning a `BoundTransport` (not just a `Server`) lets the
 * hook own the resolved descriptor — the http2 hook can promote
 * `kind: 'loopbackTcp'` to `kind: 'tls'` etc. without the factory
 * caring.
 *
 * Errors during bind MUST reject the returned promise; the factory
 * surfaces them as a `start()` rejection so phase STARTING_LISTENERS
 * fails fast (spec ch02 §3 step 5 — descriptor write is gated on a
 * successful bind).
 */
export type BindHook = (descriptor: BindDescriptor) => Promise<BoundTransport>;

/**
 * Default bind hook — opens a `net.Server`, no protocol on top. Use this
 * for v0.3 smoke runs and unit tests. T1.5 will provide an http2-aware
 * hook with the same signature.
 *
 * For UDS: deletes a stale `<path>` if it exists (a leftover socket from
 * a previous crashed daemon is the single most common cause of
 * `EADDRINUSE` on POSIX UDS — the socket file persists across crashes
 * because the kernel does NOT garbage-collect it). The unlink is
 * conditional: we `stat` first and skip if the path does not exist;
 * any other stat error rethrows untouched.
 *
 * For named pipes / loopback TCP: no pre-bind cleanup is required.
 * Named pipes are kernel objects with no FS leftover; loopback TCP
 * with `port: 0` is collision-free by construction.
 */
export const defaultBindHook: BindHook = async (descriptor) => {
  const server = createServer();

  if (descriptor.kind === 'uds') {
    await removeStaleUdsPath(descriptor.path);
  }

  await listenOnce(server, descriptor);

  const resolved = resolveBoundDescriptor(server, descriptor);

  return {
    descriptor: resolved,
    stop: () => closeServer(server, descriptor),
  };
};

/**
 * Construct Listener A. Pure — no I/O. The chosen transport, the bind
 * hook, and the platform string are all overridable so tests can drive
 * every branch without touching real sockets.
 *
 * @param env       The daemon env (read-only after boot per env.ts).
 * @param overrides Optional injection seams for tests / T1.5.
 * @returns         A `Listener` whose `start()` binds the transport.
 */
export function makeListenerA(
  env: DaemonEnv,
  overrides: {
    readonly bindHook?: BindHook;
    readonly platform?: NodePlatform;
  } = {},
): Listener {
  const platform = overrides.platform ?? process.platform;
  const bindHook = overrides.bindHook ?? defaultBindHook;
  const planned = pickTransportForListenerA(env, platform);

  // Mutable state guarded by the trait contract (start exactly once,
  // stop exactly once — spec ch03 §1 lifecycle). All state is local to
  // this closure; there is no module-level mutable state.
  let bound: BoundTransport | null = null;
  let started = false;
  let stopped = false;

  const trait: Listener = {
    id: LISTENER_A_ID,

    async start(): Promise<void> {
      if (started) {
        // Spec ch03 §1: "Idempotent-fail: throws on second call."
        throw new Error(`${LISTENER_A_ID}: start() called twice`);
      }
      started = true;
      bound = await bindHook(planned);
    },

    async stop(): Promise<void> {
      // Spec ch03 §1: "Idempotent: safe to call after a failed start."
      // We tolerate stop-before-start (no bound) and double-stop.
      if (stopped) return;
      stopped = true;
      const b = bound;
      bound = null;
      if (b !== null) {
        await b.stop();
      }
    },

    descriptor(): BindDescriptor {
      if (bound === null) {
        // Spec ch03 §1: "Calling before start() is a programming error."
        throw new Error(`${LISTENER_A_ID}: descriptor() called before start()`);
      }
      return bound.descriptor;
    },
  };

  return trait;
}

/* ------------------------------------------------------------------ */
/* Internal helpers                                                    */
/* ------------------------------------------------------------------ */

/** `server.listen(...)` as a promise. Rejects on `'error'`, resolves on
 * `'listening'`. Removes both listeners on whichever fires first so a
 * late `error` after `listening` does not leak into the unhandled
 * rejection channel. */
function listenOnce(server: Server, descriptor: BindDescriptor): Promise<void> {
  return new Promise((resolve, reject) => {
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

    switch (descriptor.kind) {
      case 'uds':
        server.listen({ path: descriptor.path });
        return;
      case 'namedPipe':
        // Node treats a Windows named-pipe path identically to a UDS
        // path: `server.listen({ path })` where `path` matches
        // `\\.\pipe\<name>`. Same `net.Server.listen` API; only the
        // string shape differs.
        server.listen({ path: descriptor.pipeName });
        return;
      case 'loopbackTcp':
        server.listen({ host: descriptor.host, port: descriptor.port });
        return;
      case 'tls':
        // Reserved for v0.4 Listener B per ch03 §1a; the v0.3 picker
        // never returns this variant. Throwing here makes a future
        // mis-pick fail loud at start() time instead of silently
        // binding nothing.
        reject(new Error(`${LISTENER_A_ID}: tls bind not supported in v0.3`));
        return;
    }
  });
}

/** Resolve the post-bind descriptor. For `loopbackTcp` with `port: 0`,
 * substitute the OS-assigned port. For UDS / named pipe, the descriptor
 * is unchanged (the OS does not rewrite the path). */
function resolveBoundDescriptor(
  server: Server,
  planned: BindDescriptor,
): BindDescriptor {
  if (planned.kind !== 'loopbackTcp') {
    return planned;
  }
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    // `string` shape happens for UDS-bound servers; we are in the
    // `loopbackTcp` branch so this is unreachable in practice. Fall
    // back to the planned descriptor rather than throw — the bind
    // already succeeded so callers should still get a usable shape.
    return planned;
  }
  return {
    kind: 'loopbackTcp',
    host: planned.host,
    port: addr.port,
  };
}

/** `server.close()` as a promise. Resolves even if the server was never
 * listening (matches the spec's "stop is idempotent" contract). */
function closeServer(server: Server, descriptor: BindDescriptor): Promise<void> {
  return new Promise((resolve) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close(() => {
      // Best-effort UDS cleanup so the next boot does not stumble over
      // a leftover socket file. We ignore errors — a missing file is
      // fine, and a permission error means an operator is responsible
      // for cleanup, not us.
      if (descriptor.kind === 'uds') {
        unlink(descriptor.path).catch(() => {
          /* swallow — see comment above */
        });
      }
      resolve();
    });
  });
}

/** Remove a stale UDS socket file before bind. No-op if the path does
 * not exist; rethrows on any error other than ENOENT. */
async function removeStaleUdsPath(path: string): Promise<void> {
  try {
    await stat(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
  // Path exists; try to unlink. If the unlink fails with ENOENT (race
  // between stat and unlink) treat it as success.
  try {
    await unlink(path);
  } catch (err) {
    if (isEnoent(err)) return;
    throw err;
  }
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}
