// Smoke test for the per-OS kill helper used by ship-gate (b)
// (`sigkill-reattach.spec.ts`) and ship-gate (c) (`pty-soak-reconnect.spec.ts`).
//
// PURPOSE
// -------
// The kill helper is the single load-bearing primitive shared by both
// gates: if it silently no-ops on any of the three target OSes, the gate
// passes vacuously (the daemon never actually dies, so of course Electron
// "reattaches"). This spec is the regression backstop:
//
//   stash kill.ts body → smoke MUST FAIL
//   restore            → smoke MUST PASS
//
// Reviewers reproduce this in PR #T8.3 review and gate the merge on the
// reverse-verify output appearing in the PR body.
//
// SCOPE
// -----
// Pure helper unit-style spec. Does NOT spawn a daemon, Electron, or
// Playwright — those wait on the dependencies enumerated in
// `sigkill-reattach.spec.ts` (T1.4 listener, T6.2 transport bridge,
// SnapshotV1 encoder, claude-sim fixture). This spec uses a tiny Node
// subprocess (`node -e "setInterval..."`) as a generic "long-running PID"
// stand-in so the kill primitive itself is exercised on every PR run, on
// every OS, in < 200 ms total.

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { platform } from 'node:os';

import { killByPid, pidIsAlive, waitForPidDead } from './kill.js';

/**
 * Spawn a long-running detached child that does nothing but hold the event
 * loop open via `setInterval`. Returns the PID immediately.
 *
 * `detached: true` on POSIX puts the child in its own process group so
 * `kill -KILL` doesn't bleed into the test runner's group. `windowsHide`
 * keeps Windows from flashing a console window during CI.
 */
function spawnLongLived(): number {
  const child = spawn(
    process.execPath,
    ['-e', 'setInterval(() => {}, 1 << 30)'],
    {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
    },
  );
  // Unref so the test runner can exit cleanly even if the kill is broken
  // (the test will still fail loudly via the `waitForPidDead` assertion;
  // unref just prevents the runner from hanging on a zombie reference).
  child.unref();
  if (typeof child.pid !== 'number') {
    throw new Error('spawnLongLived: child.pid was undefined — spawn failed silently');
  }
  return child.pid;
}

describe('kill helper — per-OS sigkill primitive (ship-gate (b)/(c) prerequisite)', () => {
  it('killByPid hard-kills a long-running subprocess on the current OS', async () => {
    const pid = spawnLongLived();

    // Pre-condition: the subprocess MUST be alive immediately after spawn.
    // If this fails, the test environment is broken (e.g. node binary
    // missing) — not a kill helper regression. Fail loud so reviewers can
    // distinguish.
    expect(pidIsAlive(pid)).toBe(true);

    // Act: deliver the OS-native uncatchable kill.
    const result = killByPid(pid);

    // Post-condition 1: kill command itself reported success.
    expect(result.delivered).toBe(true);
    expect(result.exitCode).toBe(0);

    // Post-condition 2: the PID is observed dead within the budget. This
    // is THE assertion that flips between PASS and FAIL when the kill
    // helper body is stashed — a no-op killByPid leaves the process
    // alive, waitForPidDead returns false, this expect throws.
    const dead = await waitForPidDead(pid, { timeoutMs: 5000 });
    expect(dead).toBe(true);
  });

  it('killByPid rejects non-positive PIDs without spawning anything', () => {
    // Negative / zero / non-integer PIDs would, on Windows, get passed to
    // taskkill and produce confusing errors; on POSIX, kill -KILL 0 sends
    // to every process in the calling process group (catastrophic).
    // Defense-in-depth: refuse at the helper boundary.
    expect(() => killByPid(0)).toThrow(TypeError);
    expect(() => killByPid(-1)).toThrow(TypeError);
    expect(() => killByPid(1.5)).toThrow(TypeError);
    expect(() => killByPid(Number.NaN)).toThrow(TypeError);
  });

  it('pidIsAlive returns false for an obviously-dead PID', () => {
    // Spawn + kill + wait so we KNOW the PID is reaped, then probe.
    // Using a freshly-reaped PID rather than e.g. PID 999999 avoids the
    // (very rare) collision where the OS recycled that PID for an
    // unrelated process between calls.
    const pid = spawnLongLived();
    expect(pidIsAlive(pid)).toBe(true);
    killByPid(pid);
    // Spin briefly until the OS releases the PID — POSIX zombies linger
    // until reaped; here the parent (this test) is not the parent of the
    // detached child, so the init reaper handles it within a few ms.
    return waitForPidDead(pid, { timeoutMs: 5000 }).then((dead) => {
      expect(dead).toBe(true);
      expect(pidIsAlive(pid)).toBe(false);
    });
  });

  it('reports the running platform so CI logs prove cross-OS coverage', () => {
    // Not a behavior assertion — a log-only sentinel so the GitHub Actions
    // matrix run for each OS leaves a grep-able trail proving the kill
    // helper actually executed on that OS (not silently skipped via some
    // outer guard). Reviewers can grep for "kill-helper-os=" across the
    // three matrix logs to confirm coverage.
    const os = platform();
    console.log(`[ship-gate-b] kill-helper-os=${os}`);
    expect(['linux', 'darwin', 'win32']).toContain(os);
  });
});
