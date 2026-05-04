// Lifecycle watcher: bind a per-session pty-host child handle to the
// SessionManager's terminal-state machinery. Spec ch06 §1.
//
// One call per session: `watchPtyHostChildLifecycle(handle, deps)` is
// invoked right after `spawnPtyHostChild` returns and the daemon has
// recorded the child's pid against the SessionRow. From that point the
// watcher owns the child→session bridge until the child exits.
//
// On `handle.exited()`:
//   1. SIGKILL the child's process subtree as a SAFETY NET. Spec ch06
//      §1: "child.on('exit') SIGKILLs claude/-pgid". The pty-host
//      child IS the parent of the `claude` CLI, so by the time the
//      child has exited the OS has already sent SIGCHLD to its
//      grandparent (this daemon). On linux/mac the `claude` process
//      sits in the child's process group (we spawn it with
//      `setsid`-equivalent so SIGTERM/SIGKILL on -pgid reaps the whole
//      group); on Windows `taskkill /F /T` walks the tree by parent
//      pid. Either way, calling `killProcessSubtree(handle.pid)` is
//      safe even after the child itself is gone — the kernel still
//      knows about orphaned grandchildren until they reap. Best-effort
//      and idempotent (the killer swallows ESRCH).
//
//   2. Map the `ChildExit` record to a `(reason, exit_code)` pair via
//      the pure `decideSessionEnd` decider.
//
//   3. Call `manager.markEnded(sessionId, decision)`. The manager
//      flips `should_be_running = 0`, writes the new terminal `state`
//      (CRASHED for crashed children, EXITED for graceful close), and
//      publishes the `SessionEvent.ended` on the bus so WatchSessions
//      subscribers see it. **No respawn** — spec ch06 §1 v0.3 ship rule.
//
// SRP (dev.md §3): this module is a single SINK. The producer is the
// `handle.exited()` promise from `spawnPtyHostChild` (T4.1); the
// decider is `exit-decider.ts`; the bus + DB writes happen inside
// `SessionManager.markEnded`. This file only chains the three; it has
// no decision logic of its own beyond defensive try/catch around each
// side effect so a buggy step cannot block the others.
//
// Layer 1 — alternatives checked:
//   - Inline the kill+markEnded inside `spawnPtyHostChild`'s
//     `child.on('exit')` handler in `host.ts`: rejected. `host.ts` is
//     the lifecycle producer and must NOT depend on SessionManager
//     (the dependency would cycle when SessionManager grows a
//     pty-host hook). Keeping the host pure means the same handle
//     can be wired to a test harness that asserts the IPC sequence
//     without touching SQLite.
//   - Have `SessionManager.create` return the handle and own the
//     watcher: rejected — SessionManager's SRP is row CRUD + event
//     bus. The PTY layer is a separate responsibility per the spec
//     ch06 §1 boundary; cross-wiring lives in this small adapter.
//   - Use an EventEmitter to broadcast exits across multiple
//     listeners: rejected. There is exactly one consumer per child
//     (the SessionManager), 1:1; an event-bus indirection would
//     obscure the call graph for no win.

import { killProcessSubtree } from '../ptyHost/processKiller.js';
import type { ISessionManager } from '../sessions/SessionManager.js';

import { decideSessionEnd } from './exit-decider.js';
import type { PtyHostChildHandle } from './host.js';
import type { ChildExit } from './types.js';

/**
 * Dependencies for `watchPtyHostChildLifecycle`. All fields are
 * required at runtime; the seams exist so unit tests can swap the
 * killer for a vi.fn() spy and the manager for an in-memory fake
 * without standing up a real SQLite + child fork.
 */
export interface WatchPtyHostChildLifecycleDeps {
  /**
   * SessionManager (or any object satisfying its terminal-state
   * surface) the watcher will call `markEnded` on. v0.3 daemon wires
   * the singleton SessionManager here; tests inject a fake.
   */
  readonly manager: Pick<ISessionManager, 'markEnded'>;
  /**
   * Override the process-subtree killer. Defaults to the production
   * `killProcessSubtree` from `ptyHost/processKiller.ts` (extracted
   * earlier, Task #729 Phase A). Tests pass a vi.fn() so they can
   * assert "the watcher tried to kill pid X" without spawning a real
   * subtree.
   */
  readonly killSubtree?: (pid: number) => void;
  /**
   * Override the structured-error reporter. The watcher catches
   * exceptions from the killer and from `markEnded` so a failure in
   * one step cannot prevent the other; the caught error is forwarded
   * here for log triage. Default: a `console.error` line with a
   * stable prefix the supervisor's log appender (T9.x) can grep.
   */
  readonly onError?: (where: 'kill' | 'markEnded', err: unknown) => void;
}

/**
 * Handle returned by `watchPtyHostChildLifecycle`. The watcher runs
 * autonomously once installed; the only operation a caller may need is
 * to await its completion (e.g. for a graceful daemon shutdown that
 * wants to flush every child-exit transition before exiting itself).
 */
export interface PtyHostChildWatcher {
  /**
   * Resolves with the `ChildExit` record once the watcher has finished
   * processing it (kill + markEnded both attempted). Always resolves;
   * never rejects — internal errors are routed to `onError`.
   */
  done(): Promise<ChildExit>;
}

const DEFAULT_ON_ERROR = (where: 'kill' | 'markEnded', err: unknown): void => {
  // Stable log prefix matches the SessionEventBus convention so a
  // single grep over daemon stdout surfaces both bus and watcher
  // anomalies.
  console.error(
    `[ccsm-daemon] PtyHostChildWatcher ${where} step threw`,
    err,
  );
};

/**
 * Install the child-exit watcher for a single pty-host child. Returns
 * synchronously with a handle whose `done()` promise settles after the
 * exit has been processed.
 *
 * Idempotency: the underlying `handle.exited()` promise resolves at
 * most once per child, and `SessionManager.markEnded` is itself
 * idempotent against duplicate (state, exit_code) inputs. So a caller
 * may safely re-install the watcher in a test setup without producing
 * a duplicate `SessionEvent.ended`.
 */
export function watchPtyHostChildLifecycle(
  handle: PtyHostChildHandle,
  deps: WatchPtyHostChildLifecycleDeps,
): PtyHostChildWatcher {
  const killSubtree = deps.killSubtree ?? killProcessSubtree;
  const onError = deps.onError ?? DEFAULT_ON_ERROR;

  const done = handle.exited().then((exit) => {
    // Step 1: SIGKILL the subtree (best-effort safety net for any
    // claude grandchild the child failed to reap before dying).
    try {
      killSubtree(handle.pid);
    } catch (err) {
      onError('kill', err);
    }

    // Step 2 + 3: classify the exit and persist the terminal state.
    // The decider is pure; the manager call is the side effect.
    try {
      const decision = decideSessionEnd(exit);
      deps.manager.markEnded(handle.sessionId, decision);
    } catch (err) {
      onError('markEnded', err);
    }

    return exit;
  });

  return { done: () => done };
}
