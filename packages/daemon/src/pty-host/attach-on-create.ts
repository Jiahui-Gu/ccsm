// packages/daemon/src/pty-host/attach-on-create.ts
//
// Wave-3 §6.9 sub-task 8 / Task #359 — production `attachPtyHost` factory.
//
// Wires the freshly-INSERTed SessionRow (from `SessionManager.create` /
// the CreateSession Connect handler in `sessions/create-handler.ts`) into
// the per-session pty-host child lifecycle:
//
//   1. `spawnPtyHostChild(...)` — fork the per-session child
//      (`child_process.fork`, see `host.ts`). Returns a
//      {@link PtyHostChildHandle} carrying the IPC channel + lifecycle
//      promises.
//   2. Wait for the child's `ready` IPC, then send `{kind:'spawn',
//      payload}` so the child enters its post-spawn state (logs the
//      resolved per-OS argv via #41's `computeSpawnArgv` decider, emits
//      the synthetic initial snapshot per §3.3, etc.).
//   3. Install `watchPtyHostChildLifecycle(handle, { manager })` so any
//      child exit (graceful close OR crash) is mapped through
//      `decideSessionEnd` → `SessionManager.markEnded(...)` → `should_be_running=0`
//      + new terminal state + `SessionEvent.ended` published on the bus.
//
// SCOPE — what this module is and is NOT:
//
//   * IS: a thin glue producer that closes the loop CreateSession →
//     pty-host child → markEnded. It owns NO new state. The
//     `spawnPtyHostChild` handle (#41 / PR #1004 dependency) owns the
//     child; the watcher (#42 / PR #1005) owns the child→manager bridge;
//     the `SessionManager` (#38) owns the row CRUD + event bus. This
//     file just chains them.
//
//   * IS: the production wire to the in-memory pty-host registry — the
//     `'spawn'` IPC wakes up the per-session child so the in-memory
//     `PtySessionEmitter` is registered (host.ts T-PA-5) and a future
//     `PtyService.Attach` stream from the renderer immediately finds an
//     emitter to subscribe to.
//
//   * IS NOT: a snapshot codec / xterm-headless integration — those land
//     inside `child.ts` (T4.6+) and are reachable through this same
//     spawn payload without any changes here (`screenState` is opaque
//     bytes per `types.ts`).
//
//   * IS NOT: a respawn / supervision loop — spec ch06 §1 v0.3 ship rule
//     "no respawn"; the watcher's `markEnded` is the ONLY post-exit
//     write. A new `claude` invocation requires a fresh CreateSession
//     RPC.
//
//   * IS NOT: a cwd / executable existence validator — spec ch05 §6
//     places filesystem validation in the spawn path and surfaces the
//     failure as `SessionEvent.ended { reason='crashed' }` via the
//     watcher, not as a synchronous CreateSession error (see
//     `create-handler.ts` SCOPE note for the alternatives that were
//     rejected).
//
// SRP layering (dev.md §3):
//   * decider:  `decodeSpawnPayload(row)` — pure. Parses
//               `env_json` / `claude_args_json` back into the `SpawnPayload`
//               shape `host.ts` consumes. Exported so tests can pin it
//               independently of the spawn side effect.
//   * producer: `spawnPtyHostChild(...)` from `host.ts` (#41 / PR #1004
//               supplies the per-OS argv decider that runs INSIDE the
//               child via `child.ts:handleSpawn` → `computeSpawnArgv`).
//               This file does NOT call `computeSpawnArgv` directly —
//               the child owns the argv shape (single ownership), the
//               host-side payload is the higher-level
//               `(sessionId, cwd, claudeArgs, cols, rows)` tuple.
//   * sink:     `watchPtyHostChildLifecycle(handle, { manager })` from
//               #42 / PR #1005. The watcher's job is exit→markEnded;
//               this file just installs it.
//
// Layer 1 — alternatives checked:
//   - Inline the spawn + watch into `create-handler.ts`. Rejected:
//     keeps the Connect handler proto-aware ONLY (decode request, call
//     manager, encode response). Wiring into the pty-host module belongs
//     in the pty-host module — the dependency arrow points the right way
//     (`sessions/create-handler.ts` knows about an injected
//     `attachPtyHost` callback; the implementation lives here so
//     `sessions/` does not import `pty-host/`).
//   - Make `SessionManager.create` own the spawn. Rejected: SessionManager
//     owns row CRUD + event bus; spawn is a pty-host concern. Same
//     argument the spec ch06 §1 cross-wiring boundary rejects (see
//     `lifecycle-watcher.ts` Layer 1 note).
//   - Block CreateSession on the child's `ready` IPC. Rejected: ch05 §6
//     CreateSession returns immediately with the STARTING row; the
//     pty-host bridge transitions it to RUNNING asynchronously. Coupling
//     the unary RPC to the IPC handshake would either invent a "creating"
//     intermediate state (spec mis-shape) or balloon p99 latency on a
//     handler the client expects to be sub-millisecond.
//   - Resolve the child entrypoint differently per env. Adopted via the
//     `childEntrypoint` option (the daemon-boot e2e injects the
//     `child-fixture.mjs` so vitest can fork the same JS the host.spec
//     fixture uses, since `child.ts` is not loadable by `node` directly
//     under the daemon's vitest config). Production omits the override
//     and `host.ts` falls back to its `defaultChildEntrypoint()` which
//     resolves `dist/pty-host/child.js` via `import.meta.url` math.

import { spawnPtyHostChild, type PtyHostChildHandle } from './host.js';
import { watchPtyHostChildLifecycle } from './lifecycle-watcher.js';
import type { SpawnPayload } from './types.js';

import type { ISessionManager } from '../sessions/SessionManager.js';
import type { SessionRow } from '../sessions/types.js';

/**
 * Pure decider: build the `SpawnPayload` the pty-host child expects from
 * a freshly-created `SessionRow`. The row carries `env_json` /
 * `claude_args_json` as TEXT (better-sqlite3 column type — see
 * `sessions/types.ts`); we parse them back into the structured shape the
 * IPC envelope consumes.
 *
 * Robustness: if either JSON column fails to parse (corrupted row,
 * forward-incompat row format) we fall back to empty values rather than
 * throwing — the alternative is a CreateSession that succeeds at the row
 * level but never spawns a child, leaving an orphan STARTING row. With
 * the fallback the child still spawns; if the child then crashes
 * because of bogus args, the lifecycle watcher transitions the row to
 * CRASHED through the normal path.
 */
export function decodeSpawnPayload(row: SessionRow): SpawnPayload {
  let envExtra: Record<string, string> | undefined;
  try {
    const parsed = JSON.parse(row.env_json) as unknown;
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') out[k] = v;
      }
      envExtra = out;
    }
  } catch {
    envExtra = undefined;
  }
  let claudeArgs: readonly string[] = [];
  try {
    const parsed = JSON.parse(row.claude_args_json) as unknown;
    if (Array.isArray(parsed)) {
      claudeArgs = parsed.filter((x): x is string => typeof x === 'string');
    }
  } catch {
    claudeArgs = [];
  }
  return {
    sessionId: row.id,
    cwd: row.cwd,
    claudeArgs,
    cols: row.geometry_cols,
    rows: row.geometry_rows,
    envExtra,
  };
}

/** Dependencies for the production `attachPtyHost` factory. */
export interface AttachPtyHostFactoryDeps {
  /**
   * SessionManager whose `markEnded` the lifecycle watcher will call on
   * child exit. Production wires the same singleton the SessionService
   * Connect handlers use (single owner of the sessions table — see
   * `index.ts` `sessionManager` construction).
   */
  readonly manager: Pick<ISessionManager, 'markEnded'>;
  /**
   * Override the child entrypoint script. Production omits this and
   * `host.ts` resolves `dist/pty-host/child.js` from `import.meta.url`.
   * The daemon-boot e2e (`daemon-boot-end-to-end.spec.ts`) injects the
   * `child-fixture.mjs` so vitest can fork plain ESM JS — `child.ts` is
   * not loadable by `node` directly under the daemon's vitest config
   * (no tsx loader). Read at factory-construction time, not per-call,
   * so the same value applies to every spawned session in this boot.
   */
  readonly childEntrypoint?: string;
  /**
   * Override the env passed to the forked child (NOT the env handed to
   * `claude`). Tests use this to flip `CCSM_FIXTURE_MODE`. Production
   * leaves it `undefined` to inherit `process.env` verbatim.
   */
  readonly forkEnv?: Readonly<Record<string, string | undefined>>;
  /**
   * Optional structured-error reporter. Forwarded into both the
   * `spawnPtyHostChild` failure path (synchronous `fork` errors) AND
   * the lifecycle watcher's `kill` / `markEnded` step failures. Default:
   * `console.error` with a stable `[ccsm-daemon]` prefix matching the
   * watcher's own default.
   */
  readonly onError?: (
    where: 'spawn' | 'send-spawn' | 'kill' | 'markEnded',
    err: unknown,
  ) => void;
}

const DEFAULT_ON_ERROR = (
  where: 'spawn' | 'send-spawn' | 'kill' | 'markEnded',
  err: unknown,
): void => {
  console.error(`[ccsm-daemon] attachPtyHost ${where} step threw`, err);
};

/**
 * Build the production `attachPtyHost` callback the CreateSession
 * Connect handler invokes after `SessionManager.create` returns the
 * freshly-INSERTed row.
 *
 * The returned callback is FIRE-AND-FORGET: it spawns the child, kicks
 * off the `ready → spawn IPC → watcher install` chain, and returns.
 * Errors anywhere in that chain are routed to `onError`; they do NOT
 * propagate back to the caller (CreateSession must succeed at the row
 * level even if the child fork fails — the lifecycle watcher will
 * surface the failure via a CRASHED state + `SessionEvent.ended`).
 *
 * Returns the {@link PtyHostChildHandle} for tests / the boot e2e to
 * inspect (`handle.pid` for the process-tree assertion). Production
 * callers ignore the return value.
 */
export function makeProductionAttachPtyHost(
  deps: AttachPtyHostFactoryDeps,
): (row: SessionRow) => PtyHostChildHandle | null {
  const onError = deps.onError ?? DEFAULT_ON_ERROR;
  return function attachPtyHost(row: SessionRow): PtyHostChildHandle | null {
    let handle: PtyHostChildHandle;
    try {
      handle = spawnPtyHostChild({
        payload: decodeSpawnPayload(row),
        childEntrypoint: deps.childEntrypoint,
        forkEnv: deps.forkEnv,
      });
    } catch (err) {
      onError('spawn', err);
      return null;
    }
    // Install the exit→markEnded watcher BEFORE we send `'spawn'` so a
    // child that crashes the moment it observes the spawn IPC is still
    // captured — `handle.exited()` is wired at construction time inside
    // `spawnPtyHostChild` regardless.
    watchPtyHostChildLifecycle(handle, {
      manager: deps.manager,
      onError: (where, err) => onError(where, err),
    });
    // Send `'spawn'` AFTER the child's `ready` IPC. `host.ts` rejects a
    // pre-ready `send` (channel may not yet be hot); awaiting `ready()`
    // also gives the per-session emitter time to register so a parallel
    // PtyService.Attach stream finds it.
    handle
      .ready()
      .then(() => {
        try {
          handle.send({
            kind: 'spawn',
            payload: decodeSpawnPayload(row),
          });
        } catch (err) {
          onError('send-spawn', err);
        }
      })
      .catch((err) => {
        // `ready()` rejects when the child exits before sending its
        // `ready` IPC. The watcher above already chained `markEnded` to
        // `handle.exited()`, so the row will transition to CRASHED via
        // the normal path; we just log the early-exit for triage.
        onError('send-spawn', err);
      });
    return handle;
  };
}
