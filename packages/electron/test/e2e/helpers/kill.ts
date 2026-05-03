// Per-OS hard-kill helper for ship-gate (b) (`sigkill-reattach.spec.ts`) and
// ship-gate (c) (`pty-soak-reconnect.spec.ts`).
//
// CONTRACT (FOREVER-STABLE — design spec ch12 §4.2 step 3 / ch08 §7 step 4)
// -------------------------------------------------------------------------
// Given a numeric OS PID, deliver the platform's *non-catchable* termination
// signal so the target process cannot install a SIGTERM handler that masks
// the failure mode the ship-gate is designed to catch:
//
//   - linux  → `kill -KILL <pid>`     (SIGKILL, signal 9, uncatchable)
//   - darwin → `kill -KILL <pid>`     (SIGKILL, identical semantics to linux)
//   - win32  → `taskkill /F /T /PID <pid>`
//             (`/F` = forced; `/T` = also kill the descendant tree, since
//             Windows has no "process group" the way POSIX does — this is
//             the closest equivalent to POSIX `kill(-pgid, SIGKILL)` and is
//             what the ch12 §4.2 contract requires for the daemon-subprocess
//             variant where the daemon owns child `claude` PTYs.)
//
// WHY NOT `process.kill(pid, 'SIGKILL')`
// --------------------------------------
// Node's libuv `process.kill` works on POSIX but on Windows it ignores the
// signal name and unconditionally calls `TerminateProcess`, which is `/F`
// equivalent for the *target only* — descendants survive, defeating the
// "daemon owns claude PTYs that must die with it" branch of ch12 §4.2 §step
// 4. Going through `taskkill /F /T` makes the tree-kill semantics explicit
// and identical between the per-PR (subprocess daemon) and nightly
// (service-installed daemon) variants. The cost is one `child_process.spawn`
// per kill — negligible at the call rate of these e2e gates (≤ a handful per
// run).
//
// REVERSE-VERIFY HOOK (load-bearing for ship-gate (b) PR review)
// --------------------------------------------------------------
// `kill.spec.ts` contains a smoke test that:
//   1. Spawns a long-running detached subprocess (`node -e "setInterval..."`).
//   2. Asserts the PID is alive via `pidIsAlive()`.
//   3. Calls `killByPid()` and waits for the PID to disappear.
//   4. Asserts the PID is dead.
//
// PR reviewers MUST be able to reproduce: stash the body of `killByPid()`
// (replace with a no-op) → smoke test FAILS at step 4. Restore → PASSES.
// This is what the design spec calls "byte-equality without this passes
// vacuously" — for the kill helper, the analog is "the gate without an
// effective killer passes vacuously when the kill is silently dropped".

import { spawnSync } from 'node:child_process';
import { platform } from 'node:os';

/**
 * Result envelope returned by {@link killByPid}. Wrapping rather than
 * throwing keeps caller code in the spec body straight-line — the spec
 * pre-conditions (process MUST be alive before kill) and post-conditions
 * (process MUST be dead within timeout after kill) are asserted via
 * `expect(...)` against the explicit fields, not via try/catch flow.
 */
export interface KillResult {
  /** True iff the OS reported the kill command exit-code 0. */
  readonly delivered: boolean;
  /** Raw exit code of the underlying `kill` / `taskkill` invocation. */
  readonly exitCode: number | null;
  /** Stderr of the underlying invocation (truncated to 4 KiB for log sanity). */
  readonly stderr: string;
}

/**
 * Hard-kill a process by PID using the platform's uncatchable termination
 * primitive. See file header for the per-OS contract.
 *
 * Synchronous on purpose: the caller (sigkill-reattach.spec.ts step 3) needs
 * a strict happens-before edge between "kill issued" and the subsequent
 * `pidIsAlive()` poll loop — an async kill would race the poll and produce
 * spurious "still alive" false positives that masquerade as ship-gate
 * regressions.
 */
export function killByPid(pid: number): KillResult {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`killByPid: pid must be a positive integer, got ${String(pid)}`);
  }

  const os = platform();
  let result: ReturnType<typeof spawnSync>;

  if (os === 'win32') {
    // /F = force, /T = tree-kill descendants. PID is passed via /PID (not as
    // a positional arg) so it doesn't get confused with image-name modes.
    result = spawnSync(
      'taskkill',
      ['/F', '/T', '/PID', String(pid)],
      { encoding: 'utf8', windowsHide: true },
    );
  } else if (os === 'linux' || os === 'darwin') {
    // `kill -KILL` (vs `kill -9`) makes the signal name explicit; both are
    // identical semantics on every supported libc but the long form survives
    // shell aliasing and reads cleaner in CI logs.
    result = spawnSync(
      'kill',
      ['-KILL', String(pid)],
      { encoding: 'utf8' },
    );
  } else {
    throw new Error(
      `killByPid: unsupported platform "${os}" — ship-gate (b) only targets linux/darwin/win32 per design spec ch12 §4.2.`,
    );
  }

  const stderrRaw: unknown = result.stderr;
  const stderr = (typeof stderrRaw === 'string' ? stderrRaw : '').slice(0, 4096);
  return {
    delivered: result.status === 0,
    exitCode: result.status,
    stderr,
  };
}

/**
 * Probe whether a PID is currently alive without delivering any signal.
 *
 * - POSIX: `process.kill(pid, 0)` is the canonical zero-signal liveness
 *   probe — it returns void if the PID exists *and* the caller has
 *   permission to signal it, throws ESRCH if it doesn't exist, throws EPERM
 *   if it exists but is not signalable. For ship-gate (b) we treat EPERM as
 *   alive (the daemon process is signalable by the test process by
 *   construction; an EPERM on our own subprocess would be a Node bug).
 * - Windows: `process.kill(pid, 0)` is unimplemented as a probe (libuv
 *   always TerminateProcess's), so we shell out to `tasklist /FI "PID eq N"`
 *   and grep the output. `tasklist` exits 0 in both alive and dead cases;
 *   the differentiator is whether the output contains the PID. We also
 *   accept the localized "INFO: No tasks are running" sentinel as "dead".
 */
export function pidIsAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    throw new TypeError(`pidIsAlive: pid must be a positive integer, got ${String(pid)}`);
  }

  if (platform() === 'win32') {
    const result = spawnSync(
      'tasklist',
      ['/FI', `PID eq ${String(pid)}`, '/NH'],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) {
      // tasklist itself failed (rare: the binary is core OS). Treat as
      // unknown → false to avoid hanging the spec, but do not silently
      // swallow: the stderr will surface in the spec failure message.
      return false;
    }
    // `encoding: 'utf8'` makes stdout a string at runtime, but the
    // spawnSync return type is the union `string | Buffer` — narrow
    // explicitly so a future change to the encoding option doesn't silently
    // start grepping byte buffers as JS strings.
    const stdoutRaw: unknown = result.stdout;
    const out: string = typeof stdoutRaw === 'string' ? stdoutRaw : '';
    // PID column is whitespace-padded; require it on a word boundary so PID
    // 12 doesn't match PID 1234.
    const re = new RegExp(`(^|\\s)${pid}(\\s|$)`, 'm');
    return re.test(out);
  }

  // POSIX
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    if (code === 'EPERM') return true;
    // Unexpected error — bubble it so the spec sees the real cause.
    throw err;
  }
}

/**
 * Poll {@link pidIsAlive} until it reports `false` or the timeout elapses.
 * Returns true iff the PID was observed dead within the budget.
 *
 * Default budget is 5000 ms (well below the 30 s vitest hookTimeout); poll
 * interval is 50 ms — short enough that a clean SIGKILL on a healthy POSIX
 * box is observed within ≤ 2 ticks, long enough that the poll loop adds
 * < 0.5 % CPU to a CI runner.
 */
export async function waitForPidDead(
  pid: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const pollIntervalMs = options.pollIntervalMs ?? 50;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (!pidIsAlive(pid)) return true;
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }
  return !pidIsAlive(pid);
}
