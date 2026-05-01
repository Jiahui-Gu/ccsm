// T25 — force-kill fallback after daemon-shutdown deadline overrun.
//
// Spec: docs/superpowers/specs/v0.3-fragments/frag-6-7-supervisor-rpcs.md
//   §6.4.2 — "if graceful shutdown deadline (default 5 s) overruns, the
//   dispatcher SHOULD force-kill remaining children (SIGKILL on POSIX,
//   TerminateJobObject on Win) before exit."
//
// Single Responsibility (per feedback_single_responsibility):
//   - This module is a SINK FACTORY. It returns a single zero-arg
//     `forceKillRemaining()` thunk that the daemon-shutdown handler
//     plugs into `ShutdownActions.forceKillRemaining`. The thunk
//     enumerates known surviving children and issues the per-platform
//     terminal kill primitive ONCE.
//   - The handler (T20) decides WHEN to call this (deadline-overrun
//     branch); the per-platform child trackers (T38 reaper, T39 job
//     object) decide WHO is still alive. This module is the wiring
//     glue — pure, idempotent, and platform-branch-free at the
//     decider layer.
//
// Idempotency:
//   - Second call is a no-op (the spec sequence MAY re-enter via the
//     replay path — frag-6-7 §6.6.1 — and we must not double-kill /
//     double-log).
//   - Tracked with a single boolean. Atomic-enough for single-thread
//     Node main loop; the JobObject `terminate()` is itself idempotent
//     so even a TOCTOU race here is harmless.
//
// Logging:
//   - The wrapper does NOT log — `single responsibility`. The caller
//     supplies a `recordForceKill` sink which production wires to
//     `pino.warn` (this is a degraded path; warn level is the spec
//     register for "deadline overrun → force kill"). The sink is
//     called ONCE, with the count of pids targeted on POSIX and the
//     count of job handles on Win, so a single grep finds the event.
//
// Why not import the trackers directly?
//   - The reaper's PID set and the job-object handle live in the
//     daemon's wiring module (`daemon/src/index.ts`). Importing them
//     here would couple this lifecycle module to the boot wiring and
//     break the producer/decider/sink separation. Instead we inject
//     the minimum surface needed: a `getChildPids()` snapshot for
//     POSIX and a `getJobObjects()` snapshot for Win. Tests pass
//     fakes; production passes closures over the real reaper/job
//     handles.

/**
 * Surface for issuing SIGKILL to a single PID. POSIX-only path; the
 * factory ignores this on win32. Defaults to `process.kill` in
 * production; tests inject a spy.
 */
export type PosixKillFn = (pid: number, signal: 'SIGKILL') => void;

/**
 * Minimal job-object surface this module touches. Matches the shape
 * exposed by `daemon/src/pty/win-jobobject.ts` `JobObjectHandle`.
 * We only need `terminate()` — `assign()` is irrelevant on the
 * shutdown-fallback path. Keeping the surface narrow lets tests pass
 * a `{ terminate: vi.fn() }` literal without constructing a real
 * handle.
 */
export interface ForceKillJobHandle {
  terminate(exitCode?: number): void;
}

export interface ForceKillSinkOptions {
  /**
   * POSIX-only — snapshot of PIDs still alive at the moment of
   * deadline overrun. Production wires this to
   * `() => sigchldReaper.registered()` (T38 reaper). On win32 this
   * is ignored even if supplied.
   */
  getChildPids?: () => readonly number[];
  /**
   * Win32-only — snapshot of JobObject handles to terminate. Each
   * handle's `terminate(1)` is called once. Production wires this to
   * `() => [winJob]` (the singleton from T39 wiring). On POSIX this
   * is ignored even if supplied.
   *
   * `terminate()` defaults to exit code 1 to match `process.exit(1)`
   * semantics — children appear to have died abnormally, which is
   * correct for an unscheduled forced shutdown (frag-3.5.1
   * §3.5.1.1.a `terminate(exitCode)` doc).
   */
  getJobObjects?: () => readonly ForceKillJobHandle[];
  /**
   * Per-platform terminal kill primitive. Defaults to
   * `process.kill`. Tests inject a spy. Only used on POSIX; on win32
   * the JobObject `terminate()` IS the kill primitive.
   */
  posixKill?: PosixKillFn;
  /**
   * Logged-once telemetry sink. Production wires this to
   * `pino.warn`. The wrapper itself does no logging. Called ONCE per
   * `forceKillRemaining()` invocation that does work; idempotent
   * re-calls do NOT re-log.
   *
   * `targets` is the count of PIDs (POSIX) or job handles (Win)
   * the call attempted to terminate, BEFORE any per-target failures.
   * `errors` is the count of those that threw.
   */
  recordForceKill?: (info: {
    platform: 'posix' | 'win32';
    targets: number;
    errors: number;
  }) => void;
  /**
   * Optional sink for individual per-pid / per-handle errors. The
   * wrapper does NOT re-throw — a single bad pid (already-dead,
   * permission-denied) must not block the rest of the kill loop.
   * Production wires this to `pino.warn` with the err.
   */
  onError?: (target: number | 'jobobject', err: unknown) => void;
  /**
   * Platform override for tests. Defaults to `process.platform`.
   * Tests use this to exercise both branches on a single host CI.
   */
  platform?: NodeJS.Platform;
}

export interface ForceKillSink {
  /**
   * Idempotent — first call enumerates targets and issues the
   * platform terminal kill; subsequent calls are silent no-ops.
   * Returns the number of targets the call attempted to terminate
   * (0 on a re-call or when no targets were registered).
   */
  forceKillRemaining(): number;
  /** For diagnostics / tests. True after `forceKillRemaining` ran once. */
  readonly invoked: boolean;
}

/**
 * Build a force-kill sink. Returns a closure ready to plug into
 * `ShutdownActions.forceKillRemaining` on the T20 handler.
 *
 * Both `getChildPids` and `getJobObjects` may be omitted; the
 * resulting sink is then a no-op that still satisfies the
 * `ShutdownActions` contract (used in tests / on platforms where
 * neither tracker is wired yet).
 */
export function createForceKillSink(
  options: ForceKillSinkOptions = {},
): ForceKillSink {
  const platform = options.platform ?? process.platform;
  const recordForceKill = options.recordForceKill;
  const onError = options.onError;
  const posixKill: PosixKillFn =
    options.posixKill ??
    ((pid, sig) => {
      // Cast: process.kill accepts string signals.
      process.kill(pid, sig);
    });

  let invoked = false;

  return {
    get invoked() {
      return invoked;
    },
    forceKillRemaining(): number {
      if (invoked) return 0;
      invoked = true;

      if (platform === 'win32') {
        const jobs = options.getJobObjects ? options.getJobObjects() : [];
        let errors = 0;
        for (const job of jobs) {
          try {
            job.terminate(1);
          } catch (err) {
            errors += 1;
            if (onError) onError('jobobject', err);
          }
        }
        if (jobs.length > 0 && recordForceKill) {
          recordForceKill({ platform: 'win32', targets: jobs.length, errors });
        }
        return jobs.length;
      }

      // POSIX path.
      const pids = options.getChildPids ? options.getChildPids() : [];
      let errors = 0;
      for (const pid of pids) {
        try {
          posixKill(pid, 'SIGKILL');
        } catch (err) {
          errors += 1;
          if (onError) onError(pid, err);
        }
      }
      if (pids.length > 0 && recordForceKill) {
        recordForceKill({ platform: 'posix', targets: pids.length, errors });
      }
      return pids.length;
    },
  };
}
