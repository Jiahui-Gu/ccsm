// DaemonEnv — the typed config object built once at process start from
// process.env + per-OS path defaults. Passed by reference into every
// subsystem (listeners, DB, session manager) so nothing reads process.env
// after boot. Spec ch02 §2 (per-OS service shape) + ch07 §2 (state dirs).
//
// Layer 1: no config-loading framework. Plain process.env reads, plain
// per-OS path defaults. Listener slot lives here so T1.4 can fill it
// without changing the entrypoint shape.

import { bootId } from './boot-id.js';
import { statePaths } from './state-dir/paths.js';

/** Runtime mode — `service` is the installed system service shape (ch02 §2);
 * `dev` is `npx tsx` / smoke runs from a dev tree. */
export type RuntimeMode = 'service' | 'dev';

/**
 * Typed sentinel for Listener B's slot. v0.3 ships with this value pinned
 * in `listeners[1]`; v0.4 swaps it for `makeListenerB(env)`. See spec
 * ch03 §1 for the no-mutation invariant + ESLint rule.
 *
 * NOTE: the actual `Listener` trait + `listeners` array land in T1.4 —
 * this module exposes the slot type so T1.4 can fill it without a churn
 * to DaemonEnv's shape.
 */
export const RESERVED_FOR_LISTENER_B = Symbol.for('ccsm.listener.reserved-b');
export type ReservedForListenerB = typeof RESERVED_FOR_LISTENER_B;

export interface DaemonEnvPaths {
  /** Durable state root (e.g. `%PROGRAMDATA%\ccsm`, `/var/lib/ccsm`,
   * `/Library/Application Support/ccsm`). Mirrors `statePaths().root` from
   * `state-dir/paths.ts` — same on-disk directory per spec ch07 §2. */
  stateDir: string;
  /** Listener-A descriptor file (`listener-a.json`) — see ch03 §3. */
  descriptorPath: string;
  /** Listener-A UDS / named-pipe address — see ch03 §3. */
  listenerAddr: string;
  /** Supervisor UDS / named-pipe address — see ch03 §7. */
  supervisorAddr: string;
}

export interface DaemonEnv {
  /** `service` (installed) vs `dev` (tsx smoke / unit tests). */
  readonly mode: RuntimeMode;
  /** Per-OS paths. */
  readonly paths: DaemonEnvPaths;
  /**
   * Listener slot array. Slot 0 is filled by T1.4's `makeListenerA(env)`;
   * slot 1 is the typed sentinel `RESERVED_FOR_LISTENER_B`. The slot type
   * widens to `Listener` in T1.4; for T1.1 we expose the sentinel only so
   * the entrypoint can prove the shape without importing T1.4 code.
   */
  readonly listeners: readonly [unknown, ReservedForListenerB];
  /** Per-boot UUIDv4 (see boot-id.ts + ch02 §3 step 5). */
  readonly bootId: string;
  /** Daemon binary version — read from package.json or env override. */
  readonly version: string;
  /** Build commit SHA — set by build pipeline; `'dev'` for tsx smoke runs. */
  readonly buildCommit: string;
}

// `defaultStateDir` and the default descriptor path BOTH delegate to
// `state-dir/paths.ts` so the per-OS layout has exactly one source of truth
// (spec ch07 §2; FROZEN by `test/state-dir/paths.spec.ts` per T10.7 / Task
// #122). Before this delegation, `env.ts` had its own per-OS branch that
// appended `/state` on win32+darwin but NOT on linux — a per-OS off-by-one
// that drifted from `statePaths().root`. Diagnosed out-of-scope while
// reviewing PR #931 / Task #182. The `state-dir/paths.ts` module owns the
// canonical layout; everyone else routes through it.

function defaultListenerAddr(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\ccsm-daemon';
  }
  if (process.platform === 'darwin') {
    return '/var/run/com.ccsm.daemon/daemon.sock';
  }
  return '/run/ccsm/daemon.sock';
}

function defaultSupervisorAddr(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\ccsm-supervisor';
  }
  if (process.platform === 'darwin') {
    return '/var/run/com.ccsm.daemon/supervisor.sock';
  }
  return '/run/ccsm/supervisor.sock';
}

/** Build the DaemonEnv from process.env. Called exactly once at boot from
 * `index.ts`. Throws if a required env var is malformed (none required at
 * T1.1 — every field has a sensible default). */
export function buildDaemonEnv(): DaemonEnv {
  const mode: RuntimeMode = process.env.CCSM_DAEMON_MODE === 'service' ? 'service' : 'dev';
  // Single source of truth for per-OS layout — see `state-dir/paths.ts`
  // and the comment block above the deleted `defaultStateDir`.
  const sp = statePaths();
  const stateDir = process.env.CCSM_STATE_DIR ?? sp.root;
  const listenerAddr = process.env.CCSM_LISTENER_A_ADDR ?? defaultListenerAddr();
  const supervisorAddr = process.env.CCSM_SUPERVISOR_ADDR ?? defaultSupervisorAddr();
  // When CCSM_STATE_DIR overrides the root, derive the descriptor path
  // under the override; otherwise reuse the canonical `sp.descriptor` so
  // path-separator handling stays in one place (`path.win32.join` vs posix).
  const descriptorPath =
    process.env.CCSM_DESCRIPTOR_PATH ??
    (stateDir === sp.root ? sp.descriptor : `${stateDir}/listener-a.json`);
  const version = process.env.CCSM_VERSION ?? '0.3.0-dev';
  const buildCommit = process.env.CCSM_BUILD_COMMIT ?? 'dev';

  return {
    mode,
    paths: { stateDir, descriptorPath, listenerAddr, supervisorAddr },
    // Slot 0 is `null` until T1.4 fills it with `makeListenerA(env)`.
    // Slot 1 is the typed sentinel — see ch03 §1.
    listeners: [null, RESERVED_FOR_LISTENER_B] as const,
    bootId,
    version,
    buildCommit,
  };
}
