// T38 — SIGCHLD parallel waitpid reaper (Unix only).
//
// Per feedback_single_responsibility: this module is a pure PRODUCER. On
// each SIGCHLD delivery from the kernel, it drains every exited child it
// owns by calling per-PID `waitpid(pid, WNOHANG)` and emits one
// `onChildExit(pid, status)` event per successful reap. It performs no
// state mutation, no DB write, no fan-out: the decider (T37 lifecycle
// FSM, `lifecycle.ts`) maps `(pid, status)` to a state transition; sinks
// (DB UPDATE row, fan-out emit `ptyExit`) live elsewhere.
//
// Spec: frag-3.5.1 §3.5.1.2 — daemon-owned SIGCHLD with per-PID
// `waitpid(pid, WNOHANG)` (not `waitpid(-1)`). Acceptance criterion
// (§3.5.1.6): "SIGCHLD handler reaps a synthetic forked child within
// 50ms via `waitpid(pid, WNOHANG)` (per-PID, not `waitpid(-1)`) and
// emits exactly one `ptyExit` event with `spawnTraceId` populated;
// second `waitpid` for an unrelated pid returns 0 (no double-reap)."
//
// Why per-PID instead of `waitpid(-1, WNOHANG)`?
//
//   The §3.5.1.2 contract is that the daemon owns SIGCHLD exclusively.
//   Any pid the daemon does not have on its registered set is by
//   construction not the daemon's concern; calling `waitpid(-1)` would
//   reap children the daemon never spawned (e.g. helper subprocesses
//   from libuv, native modules, or subagents). Per-PID waitpid keeps
//   ownership scoped and is easier to reason about under coalescing.
//
// SIGCHLD coalescing problem:
//
//   POSIX coalesces standard signals — N rapid SIGCHLDs may deliver as
//   one. The reaper MUST iterate the full registered-PID set on every
//   signal and call `waitpid(pid, WNOHANG)` for each one, otherwise
//   exits get lost. WNOHANG is mandatory — blocking would freeze the
//   handler.
//
// Test injection:
//
//   Node has no first-class SIGCHLD support in pure JS (libuv reserves
//   it for child_process bookkeeping). The production wiring delivers
//   SIGCHLD via the in-tree `ccsm_native.node` binding (T39, separate
//   PR). For unit-testability and to keep this module pure, both the
//   signal subscription and the per-PID waitpid call are injected via
//   the `Deps` parameter. Tests pass fakes; production passes the
//   native binding.
//
// Cross-platform: Windows has no SIGCHLD (PTY exit is observed via
// node-pty `onExit` + JobObject — see frag-3.5.1 §3.5.1.2 "Win parity"
// paragraph). `installSigchldReaper` throws on Windows — callers must
// guard with `process.platform !== 'win32'`. T39 provides the Win
// equivalent via JobObject completion-port.

/** Result of a `waitpid(pid, WNOHANG)` call. */
export interface WaitpidResult {
  /**
   * - `'exited'` — child exited (cleanly or via signal). `exitCode`
   *   and `signal` carry the status. Equivalent to `WIFEXITED` /
   *   `WIFSIGNALED` returning true.
   * - `'no-state-change'` — child is still running OR has already been
   *   reaped OR is not a child of this process (POSIX `waitpid`
   *   returning 0 or -1/ECHILD). The reaper treats both as "nothing to
   *   do for this pid right now". The native binding maps both kernel
   *   outcomes to this single state — the daemon does not need to
   *   distinguish them at this layer.
   */
  state: 'exited' | 'no-state-change';
  /** Decoded exit code (`WEXITSTATUS`). Set when state === 'exited'. */
  exitCode?: number;
  /**
   * Decoded fatal signal name (`WTERMSIG` resolved to a string like
   * `'SIGTERM'`). Set when state === 'exited' AND the child died by
   * signal. Mutually exclusive with a non-zero exitCode in practice but
   * the reaper does not enforce this — it forwards what the kernel
   * reported.
   */
  signal?: string | null;
}

/** Status payload emitted by `onChildExit`. */
export interface ChildExitStatus {
  /** Decoded exit code. May be 0 even when `signal` is set if the kernel reported both. */
  exitCode: number;
  /** Fatal signal name if the child died by signal, else null. */
  signal: string | null;
}

export type OnChildExit = (pid: number, status: ChildExitStatus) => void;

/**
 * Injected dependencies. Production wires these to the in-tree native
 * binding (T39); tests pass fakes. Keeping this surface tiny is what
 * makes the reaper a pure producer.
 */
export interface SigchldReaperDeps {
  /**
   * Subscribe to SIGCHLD delivery. The returned function MUST detach
   * the subscription. The reaper calls the supplied handler exactly
   * once per delivery (the handler internally drains all PIDs).
   */
  onSigchld: (handler: () => void) => () => void;
  /**
   * Per-PID non-blocking waitpid. MUST NOT block. MUST return
   * `{ state: 'no-state-change' }` if the child is still running or is
   * not a child of this process. MUST return `{ state: 'exited', ... }`
   * exactly once per child exit (subsequent calls return
   * `'no-state-change'`).
   */
  waitpid: (pid: number) => WaitpidResult;
}

export interface InstallSigchldReaperOptions {
  /** Sink callback fired once per reaped child. Pure producer — caller decides what to do. */
  onChildExit: OnChildExit;
  /**
   * Initial set of PIDs to reap. Optional; callers usually `register`
   * each PID at spawn time instead.
   */
  initialPids?: Iterable<number>;
  /**
   * Optional dependency injection. Defaults to the in-tree native
   * binding loader. Tests always inject fakes; production code may
   * also inject when exercising on a non-Unix sandbox.
   */
  deps?: SigchldReaperDeps;
  /**
   * Optional structured-error sink. The reaper itself does no logging
   * (single responsibility); if a per-pid waitpid throws, this
   * callback is invoked so callers can route the diagnostic. Default:
   * swallowed — the reaper continues draining the remaining PIDs.
   */
  onWaitpidError?: (pid: number, err: unknown) => void;
}

export interface SigchldReaperHandle {
  /** Add a PID to the reap set. Idempotent. */
  register(pid: number): void;
  /** Remove a PID from the reap set without reaping. Idempotent. */
  unregister(pid: number): void;
  /** Snapshot of currently registered PIDs (for diagnostics / tests). */
  registered(): number[];
  /**
   * Manually trigger a drain pass (without waiting for SIGCHLD). Used
   * by the daemon-shutdown sequence (frag-3.5.1 §3.5.1.2 step 6) to
   * collect any reaps that arrived while a SIGTERM batch was in
   * flight. Also useful in tests.
   */
  drain(): void;
  /** Detach the SIGCHLD handler and clear the registered set. */
  uninstall(): void;
}

/**
 * Install a SIGCHLD reaper. Unix-only — throws on win32.
 *
 * Contract:
 *   - On every SIGCHLD delivery, iterates the registered-PID set and
 *     calls `deps.waitpid(pid)` for each.
 *   - Each `state === 'exited'` result fires `onChildExit(pid, status)`
 *     EXACTLY ONCE and removes pid from the registered set.
 *   - `state === 'no-state-change'` is silent: pid remains registered.
 *   - `deps.waitpid` throwing is forwarded to `onWaitpidError` (if
 *     supplied) and the drain continues with the next pid; the pid
 *     stays registered so a later signal can retry.
 */
export function installSigchldReaper(
  options: InstallSigchldReaperOptions,
): SigchldReaperHandle {
  if (process.platform === 'win32') {
    throw new Error(
      'installSigchldReaper: Unix only. Windows uses JobObject completion-port (T39).',
    );
  }

  const deps = options.deps ?? loadDefaultDeps();
  const onExit = options.onChildExit;
  const onWaitpidError = options.onWaitpidError;
  const pids = new Set<number>();
  for (const pid of options.initialPids ?? []) {
    pids.add(pid);
  }

  let detach: (() => void) | null = null;
  let uninstalled = false;

  const drain = (): void => {
    if (uninstalled) return;
    // Snapshot to a local array so register/unregister calls fired
    // from inside `onExit` don't mutate the iteration.
    const snapshot = Array.from(pids);
    for (const pid of snapshot) {
      let result: WaitpidResult;
      try {
        result = deps.waitpid(pid);
      } catch (err) {
        if (onWaitpidError) onWaitpidError(pid, err);
        continue;
      }
      if (result.state !== 'exited') continue;
      // Remove BEFORE firing the callback so re-entrant register of the
      // same pid (rare, but a fast respawn path could do it) is not
      // immediately undone.
      pids.delete(pid);
      const status: ChildExitStatus = {
        exitCode: result.exitCode ?? 0,
        signal: result.signal ?? null,
      };
      onExit(pid, status);
    }
  };

  detach = deps.onSigchld(drain);

  return {
    register(pid: number): void {
      if (uninstalled) return;
      pids.add(pid);
    },
    unregister(pid: number): void {
      pids.delete(pid);
    },
    registered(): number[] {
      return Array.from(pids);
    },
    drain,
    uninstall(): void {
      if (uninstalled) return;
      uninstalled = true;
      if (detach) {
        try {
          detach();
        } finally {
          detach = null;
        }
      }
      pids.clear();
    },
  };
}

/**
 * Production-default dependency loader. The in-tree `ccsm_native.node`
 * binding is owned by T39; until it lands, this throws a clear error
 * directing callers to inject deps. Tests always inject; the daemon
 * runtime path will be wired in T39's PR alongside the binding.
 */
function loadDefaultDeps(): SigchldReaperDeps {
  throw new Error(
    'installSigchldReaper: no default native deps available yet. ' +
      'Pass `options.deps` until T39 lands the ccsm_native binding.',
  );
}
