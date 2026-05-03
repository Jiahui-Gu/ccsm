// Linux systemd watchdog keepalive — emits `WATCHDOG=1` on the daemon's
// MAIN thread every 10s so systemd's `WatchdogSec=30s` directive does not
// reap a still-running-but-blocked daemon.
//
// Spec refs:
//   - ch02 §2.3: unit declares `Type=notify`, `WatchdogSec=30s`,
//     `Restart=on-failure`, `RestartSec=5s`. The 30s budget gives 3x the
//     10s tick rate — one missed tick is recoverable, three is fatal.
//   - ch09 §6: "Daemon main thread emits `WATCHDOG=1` via `systemd-notify`
//     (or equivalent direct socket write) every 10s. Why on the main
//     thread: the main thread is what blocks on coalesced SQLite writes;
//     if it hangs, the entire RPC surface is dead."
//   - ch09 §1 (`watchdog_miss` capture-source row): a missed `WATCHDOG=1`
//     causes systemd to deliver `SIGABRT` → captured by the crash
//     collector with `owner_id = "daemon-self"`.
//
// Implementation choice — `systemd-notify` shell-out vs. direct socket
// write. Spec ch09 §6 explicitly allows both ("via `systemd-notify` (or
// equivalent direct socket write)"). v0.3 uses the shell-out path because
// Node lacks native `AF_UNIX` `SOCK_DGRAM` support:
//
//   - `node:dgram` only accepts `udp4`/`udp6` (verified: passing a UDS
//     path throws `ERR_SOCKET_BAD_PORT`).
//   - `node:net` only does `SOCK_STREAM` over AF_UNIX; systemd's notify
//     socket is `SOCK_DGRAM` per `man sd_notify`.
//   - The repo already acknowledges this constraint — see
//     `packages/daemon/src/auth/peer-cred.ts` header comment about the
//     `unix-dgram` package being unmaintained and shipping native add-ons.
//
// The direct socket write is deferred to v0.4 alongside the macOS /
// Windows watchdog work that ch09 §6 likewise defers. The exported API
// (`startSystemdWatchdog` / handle's `stop()`) is stable across that
// swap — internals change, callers do not. Per-tick fork cost of
// `systemd-notify` is ~5-10ms on Linux, dwarfed by the 10s interval, and
// it still "proves the main loop is responsive" because `child_process.spawn`
// returns synchronously from the main thread's perspective.
//
// Platform behavior:
//   - non-Linux (mac/win/dev): no-op, returns a handle whose `stop()` is
//     also a no-op. mac/win watchdog is deferred to v0.4 hardening
//     (ch09 §6 second paragraph + ch14 spike registry).
//   - Linux without `NOTIFY_SOCKET`: no-op (developer running the daemon
//     directly outside systemd). systemd sets this env on Type=notify
//     services automatically.
//   - Linux with `NOTIFY_SOCKET` but `systemd-notify` missing on PATH:
//     log once at start, then silently skip every tick (no log spam).
//     Treated as a misconfigured deployment rather than a crash because
//     systemd will reap the daemon via `WatchdogSec` if it really matters.
//
// SRP: this module is a sink (one side effect: spawn `systemd-notify` per
// tick). No decisions, no other I/O, no shared state beyond the per-handle
// timer + once-flag.

import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Cadence in milliseconds — spec ch09 §6. systemd's `WatchdogSec=30s`
 * gives 3x headroom; do not change this without the unit-file directive
 * moving in lockstep.
 */
export const WATCHDOG_INTERVAL_MS = 10_000;

/**
 * Cadence the unit file MUST declare — exported so a future test can
 * cross-check the install template (ch10 §5) against the runtime constant.
 */
export const WATCHDOG_SEC_DIRECTIVE = 30;

/**
 * Handle returned by `startSystemdWatchdog`. The daemon entrypoint holds
 * one of these for the process lifetime and calls `stop()` during graceful
 * shutdown (T1.8 path) so the timer does not keep the event loop alive.
 */
export interface SystemdWatchdogHandle {
  /** Stop the keepalive timer. Idempotent. */
  stop(): void;
  /**
   * `true` when this handle is actually emitting keepalives, `false` when
   * it is a no-op (non-Linux, NOTIFY_SOCKET unset, or systemd-notify
   * missing). Exposed for `/healthz` and tests.
   */
  isActive(): boolean;
}

/**
 * Indirection seam for tests. Production passes nothing and gets the real
 * `child_process.spawn` + `process` + `console.error`. Tests inject
 * stubs to count spawn calls without launching a real `systemd-notify`.
 */
export interface SystemdWatchdogDeps {
  readonly spawn?: typeof spawn;
  readonly platform?: NodeJS.Platform;
  readonly notifySocket?: string | undefined;
  /** Logger for the once-only "systemd-notify missing" warning. */
  readonly log?: (line: string) => void;
  /**
   * Fake-timer hook. Defaults to `setInterval` / `clearInterval` from the
   * global. Tests using vitest's fake timers do not need to override —
   * vitest patches the globals.
   */
  readonly setInterval?: typeof setInterval;
  readonly clearInterval?: typeof clearInterval;
}

/**
 * Start the systemd watchdog keepalive on the MAIN thread. The returned
 * handle's `stop()` MUST be called during graceful shutdown.
 *
 * No-op (returns an inactive handle) when:
 *   - `process.platform !== 'linux'` (mac/win/dev), OR
 *   - `process.env.NOTIFY_SOCKET` is unset (running outside systemd).
 *
 * The first tick fires immediately (not after one interval) so a hung
 * boot path is detected quickly by systemd; subsequent ticks fire every
 * `WATCHDOG_INTERVAL_MS`.
 */
export function startSystemdWatchdog(
  deps: SystemdWatchdogDeps = {},
): SystemdWatchdogHandle {
  const platform = deps.platform ?? process.platform;
  const notifySocket = 'notifySocket' in deps ? deps.notifySocket : process.env.NOTIFY_SOCKET;
  const spawnFn = deps.spawn ?? spawn;
  const log = deps.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const setIntervalFn = deps.setInterval ?? setInterval;
  const clearIntervalFn = deps.clearInterval ?? clearInterval;

  if (platform !== 'linux' || !notifySocket) {
    return inactiveHandle();
  }

  let stopped = false;
  let missingLogged = false;

  const tick = (): void => {
    if (stopped) return;
    let child: ChildProcess;
    try {
      // `stdio: 'ignore'` so the child's stdout/stderr does not pin
      // descriptors to the parent or block on unread output. `detached`
      // stays false — we want the OS to reap us as a normal child.
      child = spawnFn('systemd-notify', ['WATCHDOG=1'], { stdio: 'ignore' });
    } catch (err) {
      // `spawn` throws synchronously only on truly broken inputs; the
      // common "ENOENT systemd-notify not on PATH" lands as an `error`
      // event on the child instead. Defensive log + bail.
      if (!missingLogged) {
        missingLogged = true;
        log(`[ccsm-daemon] systemd watchdog: spawn failed (${asMessage(err)}); subsequent ticks silent`);
      }
      return;
    }
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (missingLogged) return;
      missingLogged = true;
      // ENOENT is the expected mode when the binary is not installed —
      // log it once at warning level so ops sees a single line, not one
      // per tick. Other codes (EACCES, EAGAIN) get the same treatment
      // because per-tick spam is worse than missing the diagnostic.
      log(
        `[ccsm-daemon] systemd watchdog: systemd-notify unavailable (${err.code ?? asMessage(err)}); subsequent ticks silent`,
      );
    });
  };

  // Fire once synchronously so the daemon emits its first keepalive at
  // boot rather than 10s later. Wraps in try/catch defensively — a thrown
  // error here MUST NOT crash the daemon (we are a sink).
  try {
    tick();
  } catch {
    /* swallowed — see comment above */
  }

  const timer = setIntervalFn(tick, WATCHDOG_INTERVAL_MS);
  // `unref()` so the keepalive timer does NOT keep the event loop alive
  // after every other listener has shut down. Without this, graceful
  // shutdown would hang waiting for the next tick.
  if (typeof (timer as NodeJS.Timeout).unref === 'function') {
    (timer as NodeJS.Timeout).unref();
  }

  return {
    isActive(): boolean {
      return !stopped;
    },
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(timer);
    },
  };
}

function inactiveHandle(): SystemdWatchdogHandle {
  return {
    isActive: () => false,
    stop: () => {},
  };
}

function asMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
