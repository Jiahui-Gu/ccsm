// Task #123 — daemon lockfile tests.
//
// Coverage:
//   1. `probeHolderProcess` pure decider: alive / gone / unknown
//      (POSIX kill(0) seam + Windows seam).
//   2. `acquireDaemonLock` against a real tmp dataRoot:
//      a. fresh acquire emits `lockfile_acquired` with PID + datarootMs.
//      b. release lets a second acquire succeed cleanly.
//      c. concurrent acquire (same process) → second call throws
//         `LockfileBusyError` with the live holder's PID.
//      d. stale-PID steal: pre-seed `daemon.lock.lock` dir + a PID
//         payload pointing to a dead process → acquire emits
//         `lockfile_steal` and succeeds.
//      e. EROFS-class fatal: stub proper-lockfile to throw EROFS →
//         `lockfile_erofs_fatal` log + `LockfileFatalError` thrown.
//   3. Cross-process e2e (real daemon-vs-daemon race) via two child
//      Node processes that both call `acquireDaemonLock`. The second
//      MUST exit with `LockfileBusyError` while the first still holds.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  acquireDaemonLock,
  DAEMON_LOCK_FILENAME,
  LOCKFILE_FATAL_EXIT_CODE,
  LockfileBusyError,
  LockfileFatalError,
  probeHolderProcess,
} from '../lockfile.js';

// ---------------------------------------------------------------------------
// 1. probeHolderProcess
// ---------------------------------------------------------------------------

describe('probeHolderProcess (pure decider)', () => {
  it('returns "alive" when kill(pid, 0) succeeds (POSIX path)', () => {
    const kill = vi.fn();
    expect(probeHolderProcess(1234, { kill, platform: 'linux' })).toBe('alive');
    expect(kill).toHaveBeenCalledWith(1234, 0);
  });

  it('returns "gone" on ESRCH', () => {
    const kill = vi.fn(() => {
      const err = new Error('No such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    });
    expect(probeHolderProcess(9999, { kill, platform: 'linux' })).toBe('gone');
  });

  it('returns "unknown" on EPERM (do NOT steal a lock we cannot signal)', () => {
    const kill = vi.fn(() => {
      const err = new Error('Operation not permitted') as NodeJS.ErrnoException;
      err.code = 'EPERM';
      throw err;
    });
    expect(probeHolderProcess(42, { kill, platform: 'linux' })).toBe('unknown');
  });

  it('routes through the Windows seam when one is provided', () => {
    const probeWindows = vi.fn().mockReturnValue('gone' as const);
    expect(probeHolderProcess(99, { platform: 'win32', probeWindows })).toBe('gone');
    expect(probeWindows).toHaveBeenCalledWith(99);
  });
});

// ---------------------------------------------------------------------------
// 2. acquireDaemonLock — single-process integration against real fs
// ---------------------------------------------------------------------------

interface CapturedLog {
  readonly level: 'info' | 'warn' | 'error';
  readonly obj: Record<string, unknown>;
  readonly msg: string;
}

function makeRecorder(): {
  logger: {
    info: (obj: Record<string, unknown>, msg: string) => void;
    warn: (obj: Record<string, unknown>, msg: string) => void;
    error: (obj: Record<string, unknown>, msg: string) => void;
  };
  records: CapturedLog[];
} {
  const records: CapturedLog[] = [];
  return {
    records,
    logger: {
      info: (obj, msg) => {
        records.push({ level: 'info', obj, msg });
      },
      warn: (obj, msg) => {
        records.push({ level: 'warn', obj, msg });
      },
      error: (obj, msg) => {
        records.push({ level: 'error', obj, msg });
      },
    },
  };
}

describe('acquireDaemonLock — real fs', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'ccsm-lockfile-test-'));
  });

  afterEach(() => {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('acquires fresh lock and emits `lockfile_acquired` with PID + path', async () => {
    const { logger, records } = makeRecorder();
    const handle = await acquireDaemonLock({ dataRoot, logger });
    try {
      expect(handle.path).toBe(join(dataRoot, DAEMON_LOCK_FILENAME));
      expect(handle.pid).toBe(process.pid);

      const acquired = records.find((r) => r.obj['event'] === 'lockfile_acquired');
      expect(acquired).toBeDefined();
      expect(acquired?.obj['pid']).toBe(process.pid);
      expect(acquired?.obj['path']).toBe(handle.path);
      expect(typeof acquired?.obj['datarootMs']).toBe('number');

      // PID payload is on disk for the next-boot stale-recovery probe.
      const payload = readFileSync(handle.path, 'utf8').trim();
      expect(Number.parseInt(payload, 10)).toBe(process.pid);
    } finally {
      await handle.release();
    }
  });

  it('release()-then-reacquire works (idempotent baseline)', async () => {
    const { logger } = makeRecorder();
    const first = await acquireDaemonLock({ dataRoot, logger });
    await first.release();
    // Second release is a no-op (idempotent).
    await first.release();

    const second = await acquireDaemonLock({ dataRoot, logger });
    await second.release();
  });

  it('second acquire while first is still held throws LockfileBusyError with the holder PID', async () => {
    const { logger } = makeRecorder();
    const first = await acquireDaemonLock({ dataRoot, logger });
    try {
      // The holder PID written to disk = process.pid (us). The probe
      // will find us alive and refuse the steal.
      await expect(acquireDaemonLock({ dataRoot, logger })).rejects.toBeInstanceOf(
        LockfileBusyError,
      );

      // Inspect the typed fields on a fresh attempt for stricter
      // assertions.
      try {
        await acquireDaemonLock({ dataRoot, logger });
        expect.unreachable('expected LockfileBusyError');
      } catch (err) {
        expect(err).toBeInstanceOf(LockfileBusyError);
        expect((err as LockfileBusyError).holderPid).toBe(process.pid);
        expect((err as LockfileBusyError).path).toBe(first.path);
      }
    } finally {
      await first.release();
    }
  });

  it('steals a stale lock when the holder PID is gone (emits `lockfile_steal`)', async () => {
    // Pre-seed the lockfile site exactly as a crashed prior daemon would
    // have left it: PID payload pointing to a definitely-dead PID, plus
    // the proper-lockfile `.lock` mkdir already in place.
    mkdirSync(dataRoot, { recursive: true });
    const lockPath = join(dataRoot, DAEMON_LOCK_FILENAME);
    writeFileSync(lockPath, '999999\n'); // unlikely-to-exist PID
    mkdirSync(`${lockPath}.lock`); // simulates proper-lockfile's mkdir

    const { logger, records } = makeRecorder();
    const handle = await acquireDaemonLock({
      dataRoot,
      logger,
      deps: {
        // Force the probe to report 'gone' regardless of whether PID
        // 999999 actually exists on the test host (CI VMs sometimes
        // recycle PIDs into very high numbers).
        probeOptions: {
          platform: 'linux',
          kill: () => {
            const err = new Error('No such process') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          },
        },
      },
    });

    try {
      const steal = records.find((r) => r.obj['event'] === 'lockfile_steal');
      expect(steal).toBeDefined();
      expect(steal?.obj['stale_pid']).toBe(999999);
      expect(steal?.level).toBe('warn');

      // After steal, our PID is the new payload.
      expect(readFileSync(handle.path, 'utf8').trim()).toBe(`${process.pid}`);
    } finally {
      await handle.release();
    }
  });

  it('does NOT steal a lock when the holder PID is alive', async () => {
    mkdirSync(dataRoot, { recursive: true });
    const lockPath = join(dataRoot, DAEMON_LOCK_FILENAME);
    writeFileSync(lockPath, '424242\n');
    mkdirSync(`${lockPath}.lock`);

    const { logger } = makeRecorder();
    await expect(
      acquireDaemonLock({
        dataRoot,
        logger,
        deps: {
          probeOptions: {
            platform: 'linux',
            kill: () => {
              // Holder is alive — kill(0) returns successfully.
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(LockfileBusyError);
  });

  it('emits `lockfile_erofs_fatal` and throws LockfileFatalError on EROFS', async () => {
    const { logger, records } = makeRecorder();
    // Stub proper-lockfile to throw EROFS on the lock attempt — the
    // most realistic way to simulate a read-only mount on any OS
    // (real EROFS injection requires elevated privileges).
    const stubProper = {
      lock: vi.fn(async () => {
        const err = new Error('read-only file system') as NodeJS.ErrnoException;
        err.code = 'EROFS';
        throw err;
      }),
      unlock: vi.fn(async () => {}),
      check: vi.fn(async () => false),
    };

    await expect(
      acquireDaemonLock({
        dataRoot,
        logger,
        deps: { properLockfile: stubProper },
      }),
    ).rejects.toBeInstanceOf(LockfileFatalError);

    const fatal = records.find((r) => r.obj['event'] === 'lockfile_erofs_fatal');
    expect(fatal).toBeDefined();
    expect(fatal?.level).toBe('error');
    expect(fatal?.obj['code']).toBe('EROFS');
    expect(LOCKFILE_FATAL_EXIT_CODE).toBe(78); // sysexits.h EX_CONFIG sanity
  });

  it('exposes the LockfileBusyError holderPid even when steal racer wins', async () => {
    // After a steal attempt, if a third party re-acquires before we
    // can, the second ELOCKED MUST surface as Busy (not infinite loop).
    mkdirSync(dataRoot, { recursive: true });
    const lockPath = join(dataRoot, DAEMON_LOCK_FILENAME);
    writeFileSync(lockPath, '555555\n');
    mkdirSync(`${lockPath}.lock`);

    const { logger } = makeRecorder();
    // Simulate: first lock() throws ELOCKED (stale dir is there);
    // unlock() succeeds; second lock() throws ELOCKED again (a racer
    // re-mkdir'd between unlock + retry).
    let lockCalls = 0;
    const stubProper = {
      lock: vi.fn(async () => {
        lockCalls += 1;
        const err = new Error('ELOCKED') as NodeJS.ErrnoException;
        err.code = 'ELOCKED';
        throw err;
      }),
      unlock: vi.fn(async () => {}),
      check: vi.fn(async () => true),
    };

    await expect(
      acquireDaemonLock({
        dataRoot,
        logger,
        deps: {
          properLockfile: stubProper,
          probeOptions: {
            platform: 'linux',
            kill: () => {
              const err = new Error('No such process') as NodeJS.ErrnoException;
              err.code = 'ESRCH';
              throw err;
            },
          },
        },
      }),
    ).rejects.toBeInstanceOf(LockfileBusyError);
    // Acquire path: first lock (ELOCKED) → probe says gone → unlock →
    // retry second lock (ELOCKED again) → give up via stealAttempted
    // guard. Two lock attempts total.
    expect(lockCalls).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. Cross-process race: two real Node processes contend for the same lock
// ---------------------------------------------------------------------------

describe('acquireDaemonLock — cross-process race', () => {
  let dataRoot: string;

  beforeEach(() => {
    dataRoot = mkdtempSync(join(tmpdir(), 'ccsm-lockfile-xproc-'));
  });

  afterEach(() => {
    try {
      rmSync(dataRoot, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  });

  it('second daemon process exits busy while first holds the lock', () => {
    // Compile-time path to the lockfile module via the daemon
    // tsconfig outDir is not built in test mode. We resolve it via
    // tsx so the spawned children compile on the fly.
    const repoRoot = process.cwd();
    const lockfileSrc = join(
      repoRoot,
      'daemon',
      'src',
      'lifecycle',
      'lockfile.ts',
    ).replace(/\\/g, '\\\\');

    // Child A: acquires the lock, writes "ACQUIRED" + its PID to stdout,
    // then sleeps for `holdMs` ms before releasing.
    const holdScriptA = `
      const { acquireDaemonLock } = require(${JSON.stringify(lockfileSrc)});
      const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
      (async () => {
        const handle = await acquireDaemonLock({
          dataRoot: ${JSON.stringify(dataRoot)},
          logger: noopLogger,
        });
        process.stdout.write('ACQUIRED:' + handle.pid + '\\n');
        await new Promise((r) => setTimeout(r, 10000));
        await handle.release();
        process.exit(0);
      })().catch((err) => {
        process.stderr.write('A_FAIL:' + (err && err.name) + ':' + (err && err.message) + '\\n');
        process.exit(1);
      });
    `;

    // Child B: tries to acquire, expects LockfileBusyError, prints
    // "BUSY:<holderPid>" and exits 75.
    const holdScriptB = `
      const { acquireDaemonLock, LockfileBusyError } = require(${JSON.stringify(lockfileSrc)});
      const noopLogger = { info: () => {}, warn: () => {}, error: () => {} };
      (async () => {
        try {
          const handle = await acquireDaemonLock({
            dataRoot: ${JSON.stringify(dataRoot)},
            logger: noopLogger,
          });
          process.stdout.write('UNEXPECTED_ACQUIRE:' + handle.pid + '\\n');
          await handle.release();
          process.exit(0);
        } catch (err) {
          if (err instanceof LockfileBusyError) {
            process.stdout.write('BUSY:' + err.holderPid + '\\n');
            process.exit(75);
          }
          process.stderr.write('B_OTHER:' + (err && err.name) + ':' + (err && err.message) + '\\n');
          process.exit(2);
        }
      })();
    `;

    const tsx = require.resolve('tsx/cli');

    // Launch A in the background by spawning it with no `wait`, then
    // launch B synchronously after a brief delay to ensure A grabbed
    // the lock. We use spawnSync for both — A is given a tmp script
    // file path we can detach via `detached + unref` semantics inside
    // the child itself; simpler: launch A async then wait for its
    // ACQUIRED line via a shared marker file.

    const markerPath = join(dataRoot, 'A_READY');
    const holdScriptAWithMarker = holdScriptA.replace(
      "process.stdout.write('ACQUIRED:' + handle.pid + '\\n');",
      "process.stdout.write('ACQUIRED:' + handle.pid + '\\n');" +
        "require('fs').writeFileSync(" + JSON.stringify(markerPath) + ", String(handle.pid));",
    );

    // spawn A as a backgrounded child via Node's child_process.spawn
    // (not spawnSync) so we don't block on its 1.5s sleep.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    const childA = spawn(
      process.execPath,
      [tsx, '--eval', holdScriptAWithMarker],
      { stdio: 'pipe' },
    );

    // Wait up to 20s for A to write its marker file. Polling is fine —
    // this is a single-shot test, not a hot path. The window is generous
    // because tsx cold-start under parallel-test CPU pressure can take
    // 5-10s on slow Windows runners.
    const start = Date.now();
    let aReady = false;
    while (Date.now() - start < 20_000) {
      try {
        readFileSync(markerPath, 'utf8');
        aReady = true;
        break;
      } catch {
        // sleep 50ms by spinning a sync sleep — vitest's fake timers
        // would mask real wall-clock here.
        const until = Date.now() + 50;
        // eslint-disable-next-line no-empty
        while (Date.now() < until) {}
      }
    }

    expect(aReady, 'child A failed to acquire the lock within 5s').toBe(true);

    // Now run B synchronously and verify it exits 75 with BUSY.
    const resB = spawnSync(process.execPath, [tsx, '--eval', holdScriptB], {
      encoding: 'utf8',
      timeout: 10_000,
    });

    // Clean up A regardless of outcome so the test exits cleanly.
    try {
      childA.kill();
    } catch {
      // best-effort
    }

    expect(resB.status, `B stderr=${resB.stderr}`).toBe(75);
    expect(resB.stdout).toMatch(/^BUSY:\d+/m);
  }, 60_000);
});
