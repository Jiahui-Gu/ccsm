// Public surface of the pty-host subsystem. Daemon consumers import from
// this barrel; the `child.ts` entrypoint is intentionally not re-exported
// (it is only ever loaded via `child_process.fork`).

export { spawnPtyHostChild } from './host.js';
export type { PtyHostChildHandle, SpawnPtyHostChildOptions } from './host.js';
export {
  computeUtf8SpawnEnv,
  UTF8_CONTRACT_KEYS_POSIX,
  UTF8_CONTRACT_KEYS_WIN32,
} from './spawn-env.js';
export type { Utf8EnvOptions } from './spawn-env.js';
export type {
  ChildExit,
  ChildExitReason,
  ChildToHostKind,
  ChildToHostMessage,
  HostToChildKind,
  HostToChildMessage,
  SpawnPayload,
} from './types.js';
export { decideSessionEnd } from './exit-decider.js';
export type { SessionEndDecision } from './exit-decider.js';
export { watchPtyHostChildLifecycle } from './lifecycle-watcher.js';
export type {
  PtyHostChildWatcher,
  WatchPtyHostChildLifecycleDeps,
} from './lifecycle-watcher.js';
