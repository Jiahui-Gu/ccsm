// packages/daemon/src/pty-host/__tests__/lifecycle-watcher.spec.ts
//
// Unit tests for `watchPtyHostChildLifecycle` (Task #436 coverage sweep).
// Verifies the chain `handle.exited() → killSubtree(pid) →
// decideSessionEnd(exit) → manager.markEnded(sessionId, decision)`,
// plus the defensive try/catch around each step.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { watchPtyHostChildLifecycle } from '../lifecycle-watcher.js';
import type { PtyHostChildHandle } from '../host.js';
import type { ChildExit } from '../types.js';

interface FakeHandle {
  sessionId: string;
  pid: number;
  exitedPromise: Promise<ChildExit>;
}

function makeHandle(sessionId: string, pid: number, exit: ChildExit): FakeHandle {
  return {
    sessionId,
    pid,
    exitedPromise: Promise.resolve(exit),
  };
}

function asHandle(fake: FakeHandle): PtyHostChildHandle {
  return {
    sessionId: fake.sessionId,
    pid: fake.pid,
    claudeSpawnEnv: {},
    ready: () => Promise.resolve(),
    send: () => {},
    exited: () => fake.exitedPromise,
    messages: () => ({
      [Symbol.asyncIterator]() {
        return {
          next() {
            return Promise.resolve({ value: undefined, done: true as const });
          },
        };
      },
    }),
    closeAndWait: () => fake.exitedPromise,
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('watchPtyHostChildLifecycle — graceful exit', () => {
  it('kills subtree then calls markEnded with reason=graceful, exit_code=0', async () => {
    const fake = makeHandle('s1', 4242, {
      reason: 'graceful',
      code: 0,
      signal: null,
    });
    const killSubtree = vi.fn();
    const markEnded = vi.fn();

    const watcher = watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree,
    });

    const exit = await watcher.done();

    expect(exit).toEqual({ reason: 'graceful', code: 0, signal: null });
    expect(killSubtree).toHaveBeenCalledWith(4242);
    expect(markEnded).toHaveBeenCalledWith('s1', { reason: 'graceful', exit_code: 0 });
  });
});

describe('watchPtyHostChildLifecycle — crashed exit', () => {
  it('passes the non-zero exit code through to markEnded', async () => {
    const fake = makeHandle('s2', 100, {
      reason: 'crashed',
      code: 137,
      signal: null,
    });
    const killSubtree = vi.fn();
    const markEnded = vi.fn();

    await watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree,
    }).done();

    expect(markEnded).toHaveBeenCalledWith('s2', { reason: 'crashed', exit_code: 137 });
  });

  it('passes a signal-killed exit (code null) through', async () => {
    const fake = makeHandle('s3', 200, {
      reason: 'crashed',
      code: null,
      signal: 'SIGKILL',
    });
    const markEnded = vi.fn();
    await watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree: () => {},
    }).done();
    expect(markEnded).toHaveBeenCalledWith('s3', { reason: 'crashed', exit_code: null });
  });
});

describe('watchPtyHostChildLifecycle — error isolation', () => {
  it('routes a kill-step throw to onError and STILL calls markEnded', async () => {
    const fake = makeHandle('s4', 999, {
      reason: 'crashed',
      code: 1,
      signal: null,
    });
    const killSubtree = vi.fn(() => {
      throw new Error('kill blew up');
    });
    const markEnded = vi.fn();
    const onError = vi.fn();

    await watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree,
      onError,
    }).done();

    expect(killSubtree).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith('kill', expect.any(Error));
    expect(markEnded).toHaveBeenCalledWith('s4', { reason: 'crashed', exit_code: 1 });
  });

  it('routes a markEnded throw to onError', async () => {
    const fake = makeHandle('s5', 1, {
      reason: 'crashed',
      code: 2,
      signal: null,
    });
    const markEnded = vi.fn(() => {
      throw new Error('manager exploded');
    });
    const onError = vi.fn();

    await watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree: () => {},
      onError,
    }).done();

    expect(onError).toHaveBeenCalledWith('markEnded', expect.any(Error));
  });

  it('default onError logs to console.error with the [ccsm-daemon] prefix', async () => {
    const fake = makeHandle('s6', 1, {
      reason: 'crashed',
      code: 1,
      signal: null,
    });
    const markEnded = vi.fn(() => {
      throw new Error('boom');
    });

    await watchPtyHostChildLifecycle(asHandle(fake), {
      manager: { markEnded },
      killSubtree: () => {},
      // no onError → DEFAULT_ON_ERROR is exercised
    }).done();

    expect(consoleErrorSpy).toHaveBeenCalled();
    const firstArg = consoleErrorSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain('[ccsm-daemon]');
    expect(firstArg).toContain('markEnded');
  });
});
