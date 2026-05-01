// T39 — Windows JobObject child tracking (Win32 only).
//
// Per feedback_single_responsibility: this module is a pure PRODUCER /
// SINK seam for the Windows kill-tree path. It owns the JobObject
// handle for the daemon and lets `ptyService.spawn()` (Win branch)
// `assign(pid)` each child as it comes back from `node-pty`. On
// daemon shutdown the decider calls `terminate()` which fires
// `TerminateJobObject` once and tears every assigned child down
// atomically. On daemon crash the OS handles the cleanup itself via
// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` — when the last process
// holding the job handle (the daemon) dies, the kernel terminates
// every assigned process. That guarantee is the WHOLE point of the
// JobObject path; a `taskkill /F /T /PID` shellout cannot deliver
// it (taskkill only runs while the daemon is alive to spawn it).
//
// Spec: frag-3.5.1 §3.5.1.1 (Win JobObject wiring) + §3.5.1.1.a
// (NativeBinding swap interface) + §3.5.1.2 "Win parity" paragraph
// (shutdown sequence step 6 issues `TerminateJobObject(jobHandle)`
// instead of group-SIGTERM).
//
// The native call shape (per §3.5.1.1):
//   `CreateJobObjectW`
//     → `SetInformationJobObject(JobObjectExtendedLimitInformation,
//        { BasicLimitInformation: { LimitFlags:
//            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
//          | JOB_OBJECT_LIMIT_BREAKAWAY_OK }})`
//     → `AssignProcessToJobObject(job, child.pid)`
//     → `TerminateJobObject(job, exitCode)` (shutdown only)
// The N-API binding (in-tree `ccsm_native.node`, frag-11) wraps the
// three syscalls and exposes them as `winjob.create / assign /
// terminate` per §3.5.1.1.a. This module does NOT load that binding
// directly; per the §3.5.1.1.a "no direct native import outside
// `daemon/src/native/impl/`" rule, the binding is injected (and the
// future `daemon/src/native/index.ts` shim will be the only
// production caller passing real deps).
//
// Cross-platform: on non-Win32, `createJobObject()` returns a no-op
// stub. Callers do NOT need to guard with `process.platform` —
// every Win-only call site can `createJobObject(); job.assign(pid)`
// unconditionally and the right thing happens (POSIX uses the
// SIGCHLD reaper from T38 + `setsid()` process group from
// node-pty for the equivalent reap-and-kill semantics).
//
// Test injection mirrors T38: the native `winjob` surface is
// injected through `Deps` so the module can be exercised on Linux/
// macOS CI without the `.node` artifact present, and so unit tests
// can inspect every `assign` / `terminate` call without spawning
// real processes.

/**
 * Opaque handle returned by the native `CreateJobObjectW` call.
 * The TypeScript layer never inspects it; it is forwarded back to
 * the native `assign` / `terminate` calls verbatim. The N-API
 * binding represents this as an external pointer wrapped in a
 * `napi_value` (frag-3.5.1 §3.5.1.1.a `JobHandle` type).
 */
export type JobHandle = unknown;

/**
 * Native `winjob` surface, as exposed by the in-tree
 * `ccsm_native.node` binding (frag-3.5.1 §3.5.1.1.a). Production
 * wires this through the future `daemon/src/native/index.ts` swap
 * interface; tests pass a fake.
 *
 * All methods MUST throw on non-Win32 platforms (`ENOSYS`); the
 * stub returned by `createJobObject()` for non-Win32 never reaches
 * the binding, so this is only a safety net for misconfigured
 * production wiring.
 */
export interface NativeWinjobDeps {
  /**
   * Create a new JobObject with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`
   * + `JOB_OBJECT_LIMIT_BREAKAWAY_OK` already set (the binding
   * issues `CreateJobObjectW` + `SetInformationJobObject` as a
   * single call so the JS layer never sees a job in an
   * "uninitialised limits" state).
   */
  create(): JobHandle;
  /**
   * Assign a process to the job. Wraps `AssignProcessToJobObject`.
   * MUST throw if the pid is dead, not the daemon's child, or
   * already in another job that disallows nesting (Win <8). The
   * spec's "nested-job edge case (Win 8+)" paragraph notes nested
   * jobs are allowed, so on supported targets this only fails for
   * dead pids.
   */
  assign(handle: JobHandle, pid: number): void;
  /**
   * Terminate every process in the job with the supplied exit
   * code. Wraps `TerminateJobObject`. After this returns, the
   * handle is logically dead — the daemon-shutdown sequence
   * (§3.5.1.2 step 6, Win branch) calls this exactly once.
   */
  terminate(handle: JobHandle, exitCode: number): void;
}

/**
 * Handle returned by `createJobObject()`. The shape is identical
 * across platforms so callers can treat the Win and non-Win paths
 * uniformly:
 *
 *   const job = createJobObject({ deps });
 *   const pty = spawn(...);
 *   job.assign(pty.pid);          // no-op on non-Win
 *   // ... later, on shutdown ...
 *   job.terminate();              // no-op on non-Win
 *   job.dispose();                // no-op on non-Win; future
 *                                 // CloseHandle hook on Win
 */
export interface JobObjectHandle {
  /**
   * Whether this handle is wired to a real Win32 JobObject. False
   * on non-Win32 platforms (the stub) and false after `dispose()`.
   * Mostly useful for diagnostics / tests.
   */
  readonly active: boolean;
  /**
   * Add a process to the job. Idempotent for a given pid (the
   * native side will throw on a re-assign of a pid already in this
   * job, which the wrapper swallows — `register` is the contract,
   * not "issue the syscall every time"). MUST be called
   * immediately after `node-pty` returns, before any I/O is
   * scheduled, so a child that crashes during init is still
   * inside the job for `KILL_ON_JOB_CLOSE`.
   */
  assign(pid: number): void;
  /**
   * Terminate every process in the job. Idempotent; subsequent
   * calls are no-ops. The shutdown sequence (§3.5.1.2 Win parity)
   * calls this once after the per-child SIGTERM analogue
   * (`onExit` from node-pty fires) has had its 200 ms grace, OR
   * directly when the supervisor pulls the daemon's plug.
   *
   * @param exitCode Forwarded to `TerminateJobObject`. Defaults to
   *   1 (matching `process.exit(1)` semantics — children appear to
   *   have died abnormally, which is correct for an unscheduled
   *   shutdown).
   */
  terminate(exitCode?: number): void;
  /**
   * Snapshot of currently assigned PIDs (for diagnostics + tests).
   * The JS-side set is best-effort: native `assign` failures are
   * not added; native cleanup-on-crash bypasses the JS layer. Do
   * NOT rely on this for correctness.
   */
  assigned(): number[];
  /**
   * Detach the wrapper. After dispose, `assign` / `terminate` are
   * silent no-ops. The underlying handle is left to the OS to
   * close on daemon exit (which is exactly what triggers
   * `KILL_ON_JOB_CLOSE`); explicitly closing it would release the
   * cleanup guarantee. Tests use this to reset state.
   */
  dispose(): void;
}

export interface CreateJobObjectOptions {
  /**
   * Optional dependency injection. Defaults to the in-tree native
   * binding loader. Tests always inject fakes; production code
   * also injects via the future `daemon/src/native/index.ts` shim
   * (per §3.5.1.1.a "no direct native import" rule).
   *
   * Ignored on non-Win32 platforms — the stub never touches the
   * native layer.
   */
  deps?: NativeWinjobDeps;
  /**
   * Optional sink for native errors thrown out of `assign` /
   * `terminate`. Single responsibility: the wrapper does no
   * logging. If omitted, errors are swallowed and the wrapper
   * keeps going so a single bad pid does not poison the whole
   * job. Production wires this to `pino.warn`.
   */
  onNativeError?: (op: 'assign' | 'terminate', err: unknown) => void;
}

/**
 * Allocate the daemon's JobObject. Called once at boot per the
 * §3.5.1.1 "Lifetime" paragraph; the returned handle lives for the
 * daemon's whole life and is held in a module-level binding by the
 * caller (`daemon/src/pty/winjob.ts` per spec, but that wiring
 * lands in a follow-up task — this module exposes the primitive).
 *
 * On non-Win32 platforms returns a no-op stub; callers do NOT need
 * to platform-guard.
 */
export function createJobObject(
  options: CreateJobObjectOptions = {},
): JobObjectHandle {
  if (process.platform !== 'win32') {
    return createNoopHandle();
  }

  const deps = options.deps ?? loadDefaultDeps();
  const onNativeError = options.onNativeError;

  let handle: JobHandle | null = deps.create();
  let disposed = false;
  let terminated = false;
  const assigned = new Set<number>();

  return {
    get active(): boolean {
      return !disposed && handle !== null;
    },
    assign(pid: number): void {
      if (disposed || terminated || handle === null) return;
      // Idempotent at the wrapper layer: a re-assign of a pid we
      // already tracked is a silent no-op. The native side may
      // also throw `ERROR_ACCESS_DENIED` when a pid is already in
      // the job; we surface that to onNativeError but do not let
      // it bubble.
      if (assigned.has(pid)) return;
      try {
        deps.assign(handle, pid);
        assigned.add(pid);
      } catch (err) {
        if (onNativeError) onNativeError('assign', err);
      }
    },
    terminate(exitCode = 1): void {
      if (disposed || terminated || handle === null) return;
      terminated = true;
      try {
        deps.terminate(handle, exitCode);
      } catch (err) {
        if (onNativeError) onNativeError('terminate', err);
      } finally {
        // Once terminated, assigned PIDs are dead; clear the
        // bookkeeping so a stray late `assign` of a recycled pid
        // does not silently no-op against a stale entry.
        assigned.clear();
      }
    },
    assigned(): number[] {
      return Array.from(assigned);
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      // Intentionally do NOT close the native handle. Per
      // §3.5.1.1 "Lifetime": the handle is never closed during
      // normal operation; the OS closes it on daemon exit, which
      // is the trigger for `KILL_ON_JOB_CLOSE`. Explicitly
      // closing here would release the crash-cleanup guarantee.
      handle = null;
      assigned.clear();
    },
  };
}

/**
 * Non-Win32 stub. Every method is a no-op; callers can use the
 * same handle shape across platforms without `process.platform`
 * branching. POSIX achieves the same end via `setsid()` (node-pty
 * already calls it) + the SIGCHLD reaper (T38) + the
 * shutdown-sequence group-SIGTERM/SIGKILL (§3.5.1.2 steps 6-8).
 */
function createNoopHandle(): JobObjectHandle {
  return {
    active: false,
    assign(): void {
      /* no-op */
    },
    terminate(): void {
      /* no-op */
    },
    assigned(): number[] {
      return [];
    },
    dispose(): void {
      /* no-op */
    },
  };
}

/**
 * Production-default dependency loader. The in-tree
 * `ccsm_native.node` binding is owned by frag-11 (§3.5.1.1
 * "Built artifact name"); until it lands, this throws a clear
 * error directing callers to inject deps. Tests always inject;
 * the daemon runtime path will be wired in the
 * `daemon/src/native/index.ts` shim PR alongside the binding
 * (per §3.5.1.1.a "no direct native import" rule, this module is
 * NOT allowed to `require('../native/ccsm_native.node')`
 * directly).
 *
 * The shellout fallback (`taskkill /F /T /PID <pid>`) is
 * intentionally NOT implemented here. `taskkill` only works while
 * the daemon is alive to spawn it; the WHOLE point of
 * `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is that the OS does the
 * cleanup when the daemon CRASHES (no chance to shellout).
 * Shipping a taskkill stub would silently downgrade the spec's
 * crash-cleanup guarantee to a graceful-shutdown guarantee.
 */
function loadDefaultDeps(): NativeWinjobDeps {
  throw new Error(
    'createJobObject: no default native deps available yet. ' +
      'Pass `options.deps` until the in-tree ccsm_native binding ' +
      '(frag-11 §11.4) lands and `daemon/src/native/index.ts` is wired.',
  );
}
