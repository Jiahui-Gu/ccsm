// B9 — dev-mode parent-PID watchdog.
//
// Problem (Task #25):
//   In `npm run dev`, nodemon restarts the daemon when daemon/src files
//   change. nodemon sends SIGTERM to its tsx child, but on Windows the
//   signal does not reliably propagate through the tsx wrapper to the
//   actual node grandchild (Node on Windows has no real SIGTERM; tsx
//   spawns its own subprocess). Result: each restart spawns a fresh
//   daemon while the previous one stays bound to its ULID-suffixed pipe
//   only the new boot has cleared. After a few reloads `tasklist` shows
//   N stray `ccsm-daemon` PIDs.
//
//   POSIX is mostly fine because SIGTERM does propagate, but the same
//   bug class shows up if tsx exits abnormally between signal delivery
//   and the daemon's graceful-shutdown handler completing — the daemon
//   never sees the signal and is now orphaned (re-parented to PID 1).
//
// Fix scope (DEV ONLY):
//   - Production daemon lifecycle is OWNED by the supervisor process
//     (electron/daemon/supervisor.ts). v0.3 dogfood criterion #1
//     ("daemon survives Electron close") REQUIRES the prod daemon to
//     outlive its parent — so this watchdog MUST be gated behind
//     `CCSM_DAEMON_DEV=1` and never run in a packaged build.
//   - In dev, nodemon (or its tsx child) IS the desired lifecycle
//     anchor: when it dies, the daemon should die too, otherwise the
//     next nodemon restart leaks.
//
// Strategy:
//   - On boot, capture `process.ppid`. Every `intervalMs` (default
//     500ms — fast enough to feel instant during nodemon iteration,
//     slow enough to be free), probe the parent with `process.kill(ppid, 0)`.
//     The signal-0 trick is documented Node behaviour: it tests
//     existence/permission without actually delivering a signal.
//   - If the probe throws ESRCH → parent is gone → exit immediately.
//   - Other errors (EPERM — uncommon, would mean ppid was recycled to
//     a process we can't see) are logged once and treated as "still
//     alive" so we don't false-positive kill ourselves.
//
// Single Responsibility (per dev.md §2):
//   - Pure DECIDER + minimal SINK. The deciding function `checkParent`
//     takes (`ppid`, `kill`-injectable) and returns
//     `'alive' | 'gone' | 'unknown'`. The factory `startDevParentWatchdog`
//     wires it to a setInterval timer + an `onParentGone` thunk. The
//     daemon entry passes `() => process.exit(0)` as the thunk.
//   - No I/O beyond `process.kill(_, 0)` (which is signal-free).
//
// What this does NOT do:
//   - Does not graceful-shutdown the daemon. Dev cycle is destructive
//     by design — the operator's file save invalidated the running
//     code. A 5s graceful shutdown would just delay the next nodemon
//     boot. Production graceful shutdown stays untouched (it runs in
//     the SIGTERM handler, which the supervisor still drives).
//   - Does not replace the SIGTERM handler in `daemon/src/index.ts`.
//     If the signal DOES make it through (POSIX happy path), graceful
//     shutdown still runs — this watchdog only catches the case where
//     the signal got lost.

export type ParentProbeOutcome = 'alive' | 'gone' | 'unknown';

export interface CheckParentOptions {
  /** Override `process.kill` for tests. Default: `process.kill`. */
  kill?: (pid: number, signal: 0) => void;
}

/**
 * Pure decider: probe whether `ppid` is still alive via the documented
 * `kill(pid, 0)` existence-check trick. Never throws.
 */
export function checkParent(ppid: number, opts: CheckParentOptions = {}): ParentProbeOutcome {
  const kill = opts.kill ?? ((pid: number, signal: 0): void => {
    process.kill(pid, signal);
  });
  try {
    kill(ppid, 0);
    return 'alive';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'gone';
    // EPERM (or anything else) → we cannot prove parent died. Conservative
    // posture: assume alive so we never self-terminate on a transient
    // permission glitch (Windows can briefly return EPERM during PID
    // recycling). The watchdog logs this case once via `onUnknown`.
    return 'unknown';
  }
}

export interface DevParentWatchdogOptions {
  /** ppid at boot time. Captured by caller so a re-parent does not race. */
  ppid: number;
  /** Poll interval in ms. Default 500. */
  intervalMs?: number;
  /** Sink: called once when parent transitions to `gone`. */
  onParentGone: () => void;
  /** Optional sink: called the first time we see `unknown` (logging hook). */
  onUnknown?: (ppid: number) => void;
  /** Test seam — overrides `process.kill`. */
  kill?: (pid: number, signal: 0) => void;
  /** Test seam — overrides `setInterval`. */
  setInterval?: (cb: () => void, ms: number) => NodeJS.Timeout;
  /** Test seam — overrides `clearInterval`. */
  clearInterval?: (handle: NodeJS.Timeout) => void;
}

export interface DevParentWatchdogHandle {
  stop: () => void;
}

/**
 * Start the dev-mode parent watchdog. Returns a handle whose `stop()`
 * clears the timer (used by tests; production never stops it — the
 * watchdog dies with the process it's protecting).
 *
 * Idempotent shutdown: `onParentGone` fires AT MOST ONCE even if the
 * timer somehow re-enters (e.g. test `vi.advanceTimersByTime` past
 * multiple intervals after the parent has already died).
 */
export function startDevParentWatchdog(
  opts: DevParentWatchdogOptions,
): DevParentWatchdogHandle {
  const intervalMs = opts.intervalMs ?? 500;
  const setIntervalImpl = opts.setInterval ?? setInterval;
  const clearIntervalImpl = opts.clearInterval ?? clearInterval;
  let fired = false;
  let unknownLogged = false;

  const tick = (): void => {
    if (fired) return;
    const outcome = checkParent(opts.ppid, opts.kill ? { kill: opts.kill } : {});
    if (outcome === 'gone') {
      fired = true;
      clearIntervalImpl(handle);
      opts.onParentGone();
      return;
    }
    if (outcome === 'unknown' && !unknownLogged) {
      unknownLogged = true;
      opts.onUnknown?.(opts.ppid);
    }
  };

  const handle = setIntervalImpl(tick, intervalMs);
  // Don't keep the event loop alive solely for this watchdog — the
  // daemon has its own reasons (sockets, sessions). When everything
  // else closes, this should not pin us.
  if (typeof (handle as NodeJS.Timeout).unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop: () => {
      if (fired) return;
      fired = true;
      clearIntervalImpl(handle);
    },
  };
}
