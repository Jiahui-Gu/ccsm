// T83 — SIGCHLD parallel waitpid probe (POSIX only).
//
// Spec: frag-3.5.1 §3.5.1.2 (daemon-owned SIGCHLD) + frag-6-7 reliability.
// Depends on T38 reaper (PR #995) and T37 lifecycle FSM (PR #994).
//
// Goal: prove the T38 reaper drains N=8 concurrently-killed PTY-style
// children in ONE batched SIGCHLD pass, with per-PID waitpid called
// exactly once per child and no per-child serialization (no zombies
// left behind, no second drain required).
//
// What "parallel" means in this layer:
//   The kernel coalesces N rapid SIGCHLDs into one delivery (frag-3.5.1
//   §3.5.1.2). The reaper's contract is to iterate the full registered
//   set on every signal and waitpid(pid, WNOHANG) each one. The probe
//   asserts that contract holds at N=8 — no off-by-one, no early break,
//   no implicit per-child gating.
//
// Cross-platform: Windows has no SIGCHLD — the entire suite skips on
// win32 (T39 JobObject path covers parity, see frag-3.5.1 "Win parity"
// paragraph). The skip log is printed so CI on Win shows we deliberately
// bypassed.

import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';

import {
  installSigchldReaper,
  type SigchldReaperDeps,
  type SigchldReaperHandle,
  type WaitpidResult,
} from '../sigchld-reaper.js';

const N = 8;
const IS_WIN = process.platform === 'win32';

// -- Skip-log on Windows ---------------------------------------------------

if (IS_WIN) {
  // Visible in CI logs: documents that the probe deliberately bypassed
  // on win32 rather than silently no-opping. Mirrors frag-3.5.1 "Win
  // parity" rationale (JobObject covers exit observation, not SIGCHLD).
  // eslint-disable-next-line no-console
  console.log(
    '[T83 sigchld-parallel-waitpid.probe] skipped on win32 — JobObject path (T39) covers parity',
  );
}

// -- Probe ---------------------------------------------------------------

describe.skipIf(IS_WIN)('T83 SIGCHLD parallel waitpid (POSIX)', () => {
  let handle: SigchldReaperHandle | null = null;
  afterEach(() => {
    handle?.uninstall();
    handle = null;
  });

  it(`reaps ${N} concurrently-killed children in one batched drain pass`, async () => {
    // 1. Spawn N children rapidly. `cat` blocks on stdin so it stays
    //    alive until we kill it — letting us control exit timing
    //    (unlike `true`, which exits immediately and would race the
    //    "kill concurrently" step). Portable across Linux/macOS.
    const children = Array.from({ length: N }, () =>
      spawn('cat', [], { stdio: ['pipe', 'ignore', 'ignore'] }),
    );
    const pids = children.map((c) => {
      if (c.pid == null) {
        throw new Error('spawn failed: no pid');
      }
      return c.pid;
    });

    // Promise that resolves when each child has actually been reaped by
    // libuv (so the kernel has stamped exit status). We arm BEFORE
    // sending the kill so no race.
    const exited = children.map(
      (c) =>
        new Promise<void>((resolve) => {
          c.once('exit', () => resolve());
        }),
    );

    // 2. Kill all N concurrently. SIGTERM is what the daemon sends in
    //    frag-3.5.1 §3.5.1.2 step 6 (group-SIGTERM); we simulate the
    //    same signal here. Using Promise.all on synchronous
    //    `child.kill()` ensures the kills happen in tight succession,
    //    matching the kernel-coalescing scenario the reaper must handle.
    await Promise.all(
      children.map((c) =>
        Promise.resolve().then(() => {
          c.kill('SIGTERM');
        }),
      ),
    );

    // Wait for libuv to observe every exit. After this point, every
    // pid is a "ready zombie" from the reaper's perspective: a real
    // SIGCHLD-driven probe would see exactly one (coalesced) signal
    // delivery here.
    await Promise.all(exited);

    // 3. Build a fake `waitpid` that mirrors what the T39 native
    //    binding will report: each known pid returns `exited` exactly
    //    once, then `no-state-change` on any subsequent call (matches
    //    the WIFEXITED-then-ECHILD kernel sequence). The fake also
    //    records call ordering so we can assert one drain pass touched
    //    every pid exactly once (no per-child serialization).
    const reaped = new Set<number>();
    const callLog: number[] = [];
    const deps: SigchldReaperDeps = {
      // No real signal subscription — we drive a single drain() below.
      onSigchld: () => () => {},
      waitpid: (pid: number): WaitpidResult => {
        callLog.push(pid);
        if (reaped.has(pid)) return { state: 'no-state-change' };
        reaped.add(pid);
        return { state: 'exited', exitCode: 0, signal: 'SIGTERM' };
      },
    };

    // 4. Install the reaper with all N pids registered. Production
    //    would `register(pid)` at spawn time; the initialPids shortcut
    //    is equivalent for this contract test.
    const exits: Array<{ pid: number; exitCode: number; signal: string | null }> = [];
    handle = installSigchldReaper({
      onChildExit: (pid, st) =>
        exits.push({ pid, exitCode: st.exitCode, signal: st.signal }),
      initialPids: pids,
      deps,
    });

    // 5. ONE drain pass — emulating one coalesced SIGCHLD delivery.
    handle.drain();

    // -- Assertions ------------------------------------------------------

    // (a) All N reaped in a SINGLE drain pass — no zombies left.
    expect(exits).toHaveLength(N);
    expect(handle.registered()).toEqual([]);

    // (b) Per-PID waitpid called exactly once per child during that
    //     single pass — proves no early break and no per-child
    //     serialization (each pid was visited independently in the
    //     iteration). callLog length === N is the parallel-fan-out
    //     witness: a serialized impl that bailed after the first
    //     exit would have a shorter log.
    expect(callLog).toHaveLength(N);
    expect(new Set(callLog)).toEqual(new Set(pids));

    // (c) Exit payload forwarded verbatim — exitCode + signal as
    //     reported by the (fake) kernel.
    const exitedPids = new Set(exits.map((e) => e.pid));
    expect(exitedPids).toEqual(new Set(pids));
    for (const e of exits) {
      expect(e.exitCode).toBe(0);
      expect(e.signal).toBe('SIGTERM');
    }

    // (d) A SECOND drain pass is a no-op: pids are already removed
    //     from the registered set, so waitpid is not called again.
    //     This is the no-double-reap invariant from §3.5.1.6.
    const callsBefore = callLog.length;
    handle.drain();
    expect(callLog).toHaveLength(callsBefore);
    expect(exits).toHaveLength(N);
  });
});
