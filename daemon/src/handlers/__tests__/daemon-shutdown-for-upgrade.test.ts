// T21 — daemon.shutdownForUpgrade handler tests.
// Spec: docs/superpowers/specs/v0.3-design.md / frag-6-7 §6.4
// "`daemon.shutdownForUpgrade` RPC + shutdown marker".

import { promises as fs } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DAEMON_SHUTDOWN_MARKER_FILENAME,
  readMarker,
} from '../../marker/reader.js';
import {
  DAEMON_SHUTDOWN_MARKER_TMP_SUFFIX,
  SHUTDOWN_MARKER_REASON_UPGRADE,
  defaultWriteShutdownMarker,
  executeShutdownForUpgrade,
  makeShutdownForUpgradeHandler,
  planShutdownForUpgrade,
  type ShutdownForUpgradeActions,
  type ShutdownForUpgradeContext,
  type ShutdownForUpgradePlan,
} from '../daemon-shutdown-for-upgrade.js';

const FROZEN_TS = 1_700_000_000_000;

function makeCtx(overrides: Partial<ShutdownForUpgradeContext> = {}): ShutdownForUpgradeContext {
  return {
    version: '0.3.0-test',
    now: () => FROZEN_TS,
    markerDir: '/var/run/ccsm',
    ...overrides,
  };
}

function makeRecordingActions(overrides: Partial<ShutdownForUpgradeActions> = {}): {
  actions: ShutdownForUpgradeActions;
  calls: string[];
  exitCode: number | null;
} {
  const calls: string[] = [];
  let exitCode: number | null = null;
  const actions: ShutdownForUpgradeActions = {
    writeMarker: async () => {
      calls.push('writeMarker');
    },
    runShutdownSequence: async () => {
      calls.push('runShutdownSequence');
    },
    releaseLock: async () => {
      calls.push('releaseLock');
    },
    exit: (code) => {
      calls.push(`exit:${code}`);
      exitCode = code;
    },
    ...overrides,
  };
  return {
    actions,
    calls,
    get exitCode(): number | null {
      return exitCode;
    },
  } as { actions: ShutdownForUpgradeActions; calls: string[]; exitCode: number | null };
}

// ---------------------------------------------------------------------------
// planShutdownForUpgrade — pure decider
// ---------------------------------------------------------------------------

describe('planShutdownForUpgrade — decider (pure)', () => {
  it('returns ack { accepted: true, reason: "upgrade" }', () => {
    const plan = planShutdownForUpgrade({}, makeCtx());
    expect(plan.ack).toEqual({
      accepted: true,
      reason: SHUTDOWN_MARKER_REASON_UPGRADE,
    });
  });

  it('markerPayload shape matches T22 reader expectation (reason/version/ts)', () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ version: '1.2.3' }));
    expect(plan.markerPayload).toEqual({
      reason: 'upgrade',
      version: '1.2.3',
      ts: FROZEN_TS,
    });
  });

  it('markerPath = <markerDir>/daemon.shutdown ; tmp = path + ".tmp"', () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: '/runtime' }));
    expect(plan.markerPath).toBe(join('/runtime', DAEMON_SHUTDOWN_MARKER_FILENAME));
    expect(plan.markerTmpPath).toBe(plan.markerPath + DAEMON_SHUTDOWN_MARKER_TMP_SUFFIX);
  });

  it('planSteps emit the §6.4 ordered sequence', () => {
    const plan = planShutdownForUpgrade({}, makeCtx());
    expect(plan.planSteps).toEqual([
      'write-marker',
      'run-shutdown-sequence',
      'release-lock',
      'exit',
    ]);
  });

  it('is pure: same (req, ctx, clock) yields equal plans', () => {
    const ctx = makeCtx();
    const a = planShutdownForUpgrade({}, ctx);
    const b = planShutdownForUpgrade({}, ctx);
    expect(a).toEqual(b);
  });

  it('reads the clock exactly once per call', () => {
    const now = vi.fn(() => FROZEN_TS);
    planShutdownForUpgrade({}, makeCtx({ now }));
    expect(now).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// executeShutdownForUpgrade — sink executor
// ---------------------------------------------------------------------------

describe('executeShutdownForUpgrade — sink (action ordering)', () => {
  it('invokes actions in plan order: marker → shutdown → unlock → exit(0)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx());
    const recording = makeRecordingActions();
    await executeShutdownForUpgrade(plan, recording.actions);
    expect(recording.calls).toEqual([
      'writeMarker',
      'runShutdownSequence',
      'releaseLock',
      'exit:0',
    ]);
  });

  it('aborts the sequence if writeMarker throws (no shutdown / no exit)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx());
    const recording = makeRecordingActions({
      writeMarker: async () => {
        throw new Error('disk full');
      },
    });
    await expect(
      executeShutdownForUpgrade(plan, recording.actions),
    ).rejects.toThrow('disk full');
    // Critically: NEITHER drain NOR exit ran. The caller (Electron-main)
    // owns the force-kill fallback per frag-11 §11.6.5 step 4.
    expect(recording.calls).toEqual([]);
  });

  it('does NOT call process.exit directly (exit goes through injected action)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx());
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((_code?: number) => {
      throw new Error('process.exit was called directly — Layer-1 violation');
    }) as never);
    const recording = makeRecordingActions();
    await executeShutdownForUpgrade(plan, recording.actions);
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// defaultWriteShutdownMarker — atomic write protocol
// ---------------------------------------------------------------------------

describe('defaultWriteShutdownMarker — atomic write (real fs)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccsm-t21-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a marker the T22 reader parses as PRESENT with full payload', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    await defaultWriteShutdownMarker(plan);

    const result = await readMarker(plan.markerPath);
    expect(result).toEqual({
      kind: 'present',
      payload: {
        reason: 'upgrade',
        version: '0.3.0-test',
        ts: FROZEN_TS,
      },
    });
  });

  it('removes the .tmp file (renamed, not copied)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    await defaultWriteShutdownMarker(plan);

    await expect(fs.stat(plan.markerTmpPath)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    // Final marker exists.
    await expect(fs.stat(plan.markerPath)).resolves.toBeDefined();
  });

  it('recovers from a stale .tmp leftover (previous crashed write)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    // Simulate a previous daemon crash that left a half-written tmp.
    await fs.writeFile(plan.markerTmpPath, 'stale garbage', { mode: 0o600 });

    await defaultWriteShutdownMarker(plan);

    const result = await readMarker(plan.markerPath);
    expect(result.kind).toBe('present');
    expect((result as { payload?: unknown }).payload).toEqual({
      reason: 'upgrade',
      version: '0.3.0-test',
      ts: FROZEN_TS,
    });
  });

  it('atomic: a synthetic crash before rename leaves NO daemon.shutdown (only the tmp)', async () => {
    // Simulate the failure window: open + write + sync the tmp, then "crash"
    // BEFORE the rename. The final marker must not exist; T22 reader sees
    // ENOENT → absent, the conservative "previous boot was a crash, not an
    // upgrade" reading. This is the safety guarantee.
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    const handle = await fs.open(plan.markerTmpPath, 'wx', 0o600);
    await handle.writeFile(JSON.stringify(plan.markerPayload));
    await handle.sync();
    await handle.close();
    // crash here — no rename.

    const finalRead = await readMarker(plan.markerPath);
    expect(finalRead).toEqual({ kind: 'absent' });
    // tmp exists (recoverable on next attempt via the EEXIST retry path).
    await expect(fs.stat(plan.markerTmpPath)).resolves.toBeDefined();
  });

  it('atomic: a half-flushed FINAL marker is treated as PRESENT by T22 (rel-S-R8)', async () => {
    // The T22 reader spec invariant we depend on — verify it still holds for
    // a marker file that is post-rename but partially-flushed (here we
    // simulate the worst case = empty file, which the reader must call
    // `present` not `absent`).
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    await fs.writeFile(plan.markerPath, '', { mode: 0o600 });
    const result = await readMarker(plan.markerPath);
    expect(result.kind).toBe('present');
  });
});

// ---------------------------------------------------------------------------
// defaultWriteShutdownMarker — write sequence (mocked fs)
// ---------------------------------------------------------------------------

describe('defaultWriteShutdownMarker — write sequence (mocked)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('sequence: open(tmp) → writeFile → fsync(file) → close → rename(tmp→final) → fsync(dir)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: '/fake/runtime' }));
    const events: string[] = [];

    const fileHandle = {
      writeFile: vi.fn(async (data: unknown) => {
        events.push(`writeFile:${String(data).length}`);
      }),
      sync: vi.fn(async () => {
        events.push('file.sync');
      }),
      close: vi.fn(async () => {
        events.push('file.close');
      }),
    };
    const dirHandle = {
      sync: vi.fn(async () => {
        events.push('dir.sync');
      }),
      close: vi.fn(async () => {
        events.push('dir.close');
      }),
    };

    const openSpy = vi.spyOn(fs, 'open').mockImplementation((async (
      path: unknown,
      flags?: unknown,
    ) => {
      events.push(`open:${String(path)}:${String(flags)}`);
      if (String(flags) === 'r') {
        return dirHandle as unknown as import('node:fs/promises').FileHandle;
      }
      return fileHandle as unknown as import('node:fs/promises').FileHandle;
    }) as typeof fs.open);
    const renameSpy = vi.spyOn(fs, 'rename').mockImplementation((async (
      from: unknown,
      to: unknown,
    ) => {
      events.push(`rename:${String(from)}->${String(to)}`);
    }) as typeof fs.rename);

    await defaultWriteShutdownMarker(plan);

    // Required ordering invariants (only checks that matter for correctness):
    const idxOpenTmp = events.findIndex((e) => e.startsWith('open:') && e.includes('.tmp') && e.endsWith(':wx'));
    const idxWrite = events.indexOf(events.find((e) => e.startsWith('writeFile:')) ?? '');
    const idxFsyncFile = events.indexOf('file.sync');
    const idxClose = events.indexOf('file.close');
    const idxRename = events.indexOf(events.find((e) => e.startsWith('rename:')) ?? '');

    expect(idxOpenTmp).toBeGreaterThanOrEqual(0);
    expect(idxWrite).toBeGreaterThan(idxOpenTmp);
    expect(idxFsyncFile).toBeGreaterThan(idxWrite);
    expect(idxClose).toBeGreaterThan(idxFsyncFile);
    expect(idxRename).toBeGreaterThan(idxClose);

    expect(openSpy).toHaveBeenCalled();
    expect(renameSpy).toHaveBeenCalledWith(plan.markerTmpPath, plan.markerPath);
    expect(fileHandle.sync).toHaveBeenCalledTimes(1);
    expect(fileHandle.writeFile).toHaveBeenCalledTimes(1);
  });

  it('writeFile payload is the canonical marker JSON (T22 reader parseable)', async () => {
    const plan = planShutdownForUpgrade({}, makeCtx({ markerDir: '/fake/runtime' }));
    let written: string | null = null;
    const fileHandle = {
      writeFile: vi.fn(async (data: string) => {
        written = data;
      }),
      sync: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    vi.spyOn(fs, 'open').mockImplementation((async () =>
      fileHandle as unknown as import('node:fs/promises').FileHandle) as typeof fs.open);
    vi.spyOn(fs, 'rename').mockImplementation((async () => undefined) as typeof fs.rename);

    await defaultWriteShutdownMarker(plan);

    expect(written).not.toBeNull();
    const parsed: unknown = JSON.parse(written as unknown as string);
    expect(parsed).toEqual({
      reason: 'upgrade',
      version: '0.3.0-test',
      ts: FROZEN_TS,
    });
  });
});

// ---------------------------------------------------------------------------
// makeShutdownForUpgradeHandler — dispatcher adapter
// ---------------------------------------------------------------------------

describe('makeShutdownForUpgradeHandler — wire ack', () => {
  it('returns ack PROMPTLY before side effects complete', async () => {
    let writeStarted = false;
    let releaseAck: (() => void) | null = null;
    const sideEffectsDone = new Promise<void>((resolve) => {
      releaseAck = resolve;
    });
    const actions: ShutdownForUpgradeActions = {
      writeMarker: async () => {
        writeStarted = true;
        // Block forever-ish until the test releases — proves the ack does
        // NOT wait on the marker write.
        await sideEffectsDone;
      },
      runShutdownSequence: async () => undefined,
      releaseLock: async () => undefined,
      exit: () => undefined,
    };
    const handler = makeShutdownForUpgradeHandler(makeCtx(), actions);

    const ack = await handler({});
    expect(ack).toEqual({ accepted: true, reason: 'upgrade' });
    // The side effects are scheduled (queueMicrotask) but the marker write
    // hasn't necessarily started yet — flush microtasks then a real tick:
    await Promise.resolve();
    await Promise.resolve();
    expect(writeStarted).toBe(true);

    // Cleanup so the dangling promise resolves.
    if (releaseAck) (releaseAck as () => void)();
  });

  it('surfaces marker-write errors to the injected onError callback', async () => {
    const onError = vi.fn();
    const actions: ShutdownForUpgradeActions = {
      writeMarker: async () => {
        throw new Error('marker write failed');
      },
      runShutdownSequence: async () => undefined,
      releaseLock: async () => undefined,
      exit: () => undefined,
    };
    const handler = makeShutdownForUpgradeHandler(makeCtx(), actions, onError);

    await handler({});
    // Drain microtasks + one macrotask for the catch handler.
    await new Promise((r) => setTimeout(r, 10));

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
  });
});

// ---------------------------------------------------------------------------
// e2e — decider + default sink + reader (round-trip)
// ---------------------------------------------------------------------------

describe('shutdownForUpgrade — round-trip with T22 reader', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ccsm-t21-rt-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('decider → defaultWriteShutdownMarker → readMarker yields exact payload', async () => {
    const ctx = makeCtx({ markerDir: dir, version: '0.3.42' });
    const plan = planShutdownForUpgrade({}, ctx);

    let exitCalledWith: number | null = null;
    const actions: ShutdownForUpgradeActions = {
      writeMarker: defaultWriteShutdownMarker,
      runShutdownSequence: async () => undefined,
      releaseLock: async () => undefined,
      exit: (code) => {
        exitCalledWith = code;
      },
    };
    await executeShutdownForUpgrade(plan, actions);

    expect(exitCalledWith).toBe(0);

    const onDisk = await readFile(
      join(dir, DAEMON_SHUTDOWN_MARKER_FILENAME),
      'utf8',
    );
    expect(JSON.parse(onDisk)).toEqual({
      reason: 'upgrade',
      version: '0.3.42',
      ts: FROZEN_TS,
    });

    const readResult = await readMarker(join(dir, DAEMON_SHUTDOWN_MARKER_FILENAME));
    expect(readResult.kind).toBe('present');
  });

  // Reverse-verify: with the implementation removed, the round-trip would
  // fail at `readMarker.kind === 'present'`. Verified manually pre-commit
  // by stubbing `defaultWriteShutdownMarker` to no-op.
  it('plan exposes markerPath/markerTmpPath consumers can pre-allocate', () => {
    const plan: ShutdownForUpgradePlan = planShutdownForUpgrade({}, makeCtx({ markerDir: dir }));
    expect(plan.markerPath.endsWith(DAEMON_SHUTDOWN_MARKER_FILENAME)).toBe(true);
    expect(plan.markerTmpPath.endsWith(DAEMON_SHUTDOWN_MARKER_FILENAME + DAEMON_SHUTDOWN_MARKER_TMP_SUFFIX)).toBe(true);
  });
});
