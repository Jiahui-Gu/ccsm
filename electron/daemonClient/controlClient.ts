// electron/daemonClient/controlClient.ts
//
// Typed facade over `createRpcClient` for the control-socket plane (spec
// frag-3.4.1 §3.4.1.h `SUPERVISOR_RPCS`). Today it exposes one RPC the v0.3
// codebase actually calls — `daemon.shutdownForUpgrade` — and feeds the
// existing `setUpgradeShutdownRpc(...)` injection seam in `electron/updater.ts`
// (T62 / frag-11 §11.6.5). When the daemon-side adds the other supervisor
// RPCs (`daemon.shutdown`, `/healthz`, `/stats`) and Electron-main acquires
// callers for them, those land here as additional thin wrappers without
// changing the underlying RPC client.
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.h `SUPERVISOR_RPCS = ["/healthz", "/stats",
//     "daemon.hello", "daemon.shutdown", "daemon.shutdownForUpgrade"]`
//     — control-socket method allowlist.
//   - frag-11 §11.6.5 step 3: 5 s ack window from the moment we write the
//     `daemon.shutdownForUpgrade` envelope to the moment we receive the
//     reply. The 5_000 ms is provided by the caller (`updater.ts`'s
//     `UPGRADE_SHUTDOWN_ACK_TIMEOUT_MS`) which is the canonical owner; this
//     module just passes it as a per-call timeout so the RPC client's
//     transport-level timeout matches the spec ack window.
//
// Why a separate facade vs calling `client.call()` directly from updater.ts:
//   - Keeps the RPC client transport-only and reusable for the data-socket
//     plane (`createDataClient(...)` is a future slice with the same shape).
//   - The typed `UpgradeShutdownAck` (re-exported from `updater.ts`'s
//     interface) lives at one site so a future schema bump only edits one
//     place.

import {
  createRpcClient,
  RpcTransportError,
  type RpcClient,
  type RpcClientOptions,
} from './rpcClient';
import type { UpgradeShutdownAck, UpgradeShutdownRpc } from '../updater';

export const SHUTDOWN_FOR_UPGRADE_METHOD = 'daemon.shutdownForUpgrade' as const;

/** Spec frag-11 §11.6.5 step 3 ack window. Mirrored here as the per-call
 *  RPC timeout so the transport-level deadline matches the spec window even
 *  if the caller's outer race (`callShutdownForUpgrade`) is ever bypassed. */
export const SHUTDOWN_FOR_UPGRADE_TIMEOUT_MS = 5_000;

export interface ControlClient {
  /** The underlying RPC client — exposed so callers can `.close()` it on
   *  Electron quit and inspect `isConnected` for debug overlays. */
  readonly rpc: RpcClient;
  /** Typed wrapper for `daemon.shutdownForUpgrade` matching the
   *  `UpgradeShutdownRpc` shape `electron/updater.ts` expects. Throws on
   *  transport failure (timeout, disconnect) so the caller's existing
   *  `Promise.race` against the 5 s window funnels both surfaces through
   *  one branch. Application-level rejections (rare for this RPC — the
   *  daemon handler has no inputs to fail on) surface as a thrown
   *  `Error(error.code: error.message)`. */
  callShutdownForUpgrade: UpgradeShutdownRpc;
}

export interface CreateControlClientOptions {
  /** Absolute control-socket path (POSIX) or Windows named-pipe name —
   *  resolved by `electron/daemon/bootDaemon.ts:resolveControlSocketPath`. */
  readonly socketPath: string;
  /** Test seam — passed straight through. */
  readonly connectFn?: RpcClientOptions['connectFn'];
  /** Test seam — passed straight through. */
  readonly log?: RpcClientOptions['log'];
}

export function createControlClient(opts: CreateControlClientOptions): ControlClient {
  const rpc = createRpcClient({
    socketPath: opts.socketPath,
    defaultTimeoutMs: SHUTDOWN_FOR_UPGRADE_TIMEOUT_MS,
    ...(opts.connectFn ? { connectFn: opts.connectFn } : {}),
    ...(opts.log ? { log: opts.log } : {}),
  });

  const callShutdownForUpgrade: UpgradeShutdownRpc = async () => {
    let reply;
    try {
      reply = await rpc.call(SHUTDOWN_FOR_UPGRADE_METHOD, undefined, {
        timeoutMs: SHUTDOWN_FOR_UPGRADE_TIMEOUT_MS,
      });
    } catch (err) {
      // Transport failure — re-throw so the outer `callShutdownForUpgrade`
      // (`updater.ts`) classifies as `{ kind: 'error', message }`. The
      // outer race against the 5 s window already proceeds-anyway per the
      // spec's force-kill fallback so this is informational only.
      if (err instanceof RpcTransportError) {
        throw new Error(`${err.code}: ${err.message}`);
      }
      throw err as Error;
    }
    if (!reply.ok) {
      throw new Error(`${reply.error.code}: ${reply.error.message}`);
    }
    // The daemon handler returns `{ accepted: true, reason: 'upgrade' }`
    // (see `daemon/src/handlers/daemon-shutdown-for-upgrade.ts`
    // `ShutdownForUpgradeAck`). Validate the shape just enough to honor the
    // typed contract; an unexpected shape becomes an error so the outer
    // race classifies correctly.
    const value = reply.value as Partial<UpgradeShutdownAck> | undefined;
    if (!value || value.accepted !== true || value.reason !== 'upgrade') {
      throw new Error(
        `daemon.shutdownForUpgrade: malformed ack ${JSON.stringify(reply.value)}`,
      );
    }
    return { accepted: true, reason: 'upgrade' };
  };

  return { rpc, callShutdownForUpgrade };
}
