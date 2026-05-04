// Unit tests for `watchPtyHostChildLifecycle` (T4.4 / Task #42).
//
// The watcher is a small sink that chains three steps after the
// child's `exited()` promise resolves:
//   (1) killSubtree(handle.pid)  — SIGKILL grandchildren safety net
//   (2) decideSessionEnd(exit)   — pure decider (covered separately)
//   (3) manager.markEnded(...)   — flip should_be_running, emit event
//
// These tests stub the handle and manager so we can exercise every
// branch (graceful close, crash, kill throw, markEnded throw) without
// forking a real child or opening a SQLite database. The real
// integration via `spawnPtyHostChild` + a fork fixture is exercised by
// the host.spec.ts crash-semantics block (T4.1) — this file pins the
// watcher's own contract.

import { describe, expect, it, vi } from 'vitest';

import { watchPtyHostChildLifecycle } from '../../src/pty-host/lifecycle-watcher.js';
import type { PtyHostChildHandle } from '../../src/pty-host/host.js';
import type { ChildExit } from '../../src/pty-host/types.js';
import type { ISessionManager } from '../../src/sessions/SessionManager.js';
import type { SessionRow } from '../../src/sessions/types.js';
import { SessionState } from '../../src/sessions/types.js';

interface StubHandle extends PtyHostChildHandle {
  /** Resolve the underlying `exited()` promise from the test body. */
  resolveExit(exit: ChildExit): void;
}

function makeHandle(sessionId: string, pid: number): StubHandle {
  let resolveExit: (x: ChildExit) => void = () => {
    /* set below */
  };
  const exitedPromise = new Promise<ChildExit>((resolve) => {
    resolveExit = resolve;
  });
  // We only fill the surface the watcher consumes; other methods throw
  // so an accidental call during the test is loud.
  const notUsed = (): never => {
    throw new Error('watcher should not call this method');
  };
  const handle: StubHandle = {
    sessionId,
    pid,
    claudeSpawnEnv: {},
    ready: notUsed,
    send: notUsed,
    exited: () => exitedPromise,
    messages: notUsed,
    closeAndWait: notUsed,
    resolveExit,
  };
  return handle;
}

function makeManager(): {
  manager: Pick<ISessionManager, 'markEnded'>;
  calls: Array<{ id: string; reason: string; exit_code: number | null }>;
} {
  const calls: Array<{ id: string; reason: string; exit_code: number | null }> = [];
  const manager: Pick<ISessionManager, 'markEnded'> = {
    markEnded(id, params): SessionRow {
      calls.push({ id, reason: params.reason, exit_code: params.exit_code });
      // Return a synthetic row — the watcher does not inspect it.
      return {
        id,
        owner_id: 'local-user:1000',
        state:
          params.reason === 'crashed' ? SessionState.CRASHED : SessionState.EXITED,
        cwd: '/',
        env_json: '{}',
        claude_args_json: '[]',
        geometry_cols: 80,
        geometry_rows: 24,
        exit_code: params.exit_code ?? -1,
        created_ms: 1,
        last_active_ms: 2,
        should_be_running: 0,
      };
    },
  };
  return { manager, calls };
}

describe('watchPtyHostChildLifecycle — happy paths', () => {
  it('on graceful exit: kills the subtree then calls markEnded with reason=graceful, exit_code=0', async () => {
    const handle = makeHandle('sess-graceful', 12345);
    const { manager, calls } = makeManager();
    const killSpy = vi.fn();

    const watcher = watchPtyHostChildLifecycle(handle, {
      manager,
      killSubtree: killSpy,
    });

    handle.resolveExit({ reason: 'graceful', code: 0, signal: null });
    const observed = await watcher.done();

    expect(killSpy).toHaveBeenCalledExactlyOnceWith(12345);
    expect(calls).toEqual([
      { id: 'sess-graceful', reason: 'graceful', exit_code: 0 },
    ]);
    expect(observed).toEqual({ reason: 'graceful', code: 0, signal: null });
  });

  it('on crash exit (code 137): kills the subtree then calls markEnded with reason=crashed', async () => {
    const handle = makeHandle('sess-crash', 22222);
    const { manager, calls } = makeManager();
    const killSpy = vi.fn();

    const watcher = watchPtyHostChildLifecycle(handle, {
      manager,
      killSubtree: killSpy,
    });

    handle.resolveExit({ reason: 'crashed', code: 137, signal: null });
    await watcher.done();

    expect(killSpy).toHaveBeenCalledExactlyOnceWith(22222);
    expect(calls).toEqual([
      { id: 'sess-crash', reason: 'crashed', exit_code: 137 },
    ]);
  });

  it('on signal-killed exit: passes null exit_code through to markEnded', async () => {
    const handle = makeHandle('sess-signal', 33333);
    const { manager, calls } = makeManager();
    const watcher = watchPtyHostChildLifecycle(handle, {
      manager,
      killSubtree: vi.fn(),
    });

    handle.resolveExit({ reason: 'crashed', code: null, signal: 'SIGKILL' });
    await watcher.done();

    expect(calls).toEqual([
      { id: 'sess-signal', reason: 'crashed', exit_code: null },
    ]);
  });
});

describe('watchPtyHostChildLifecycle — error containment', () => {
  it('still calls markEnded if the killer throws (kill error is reported, not propagated)', async () => {
    const handle = makeHandle('sess-kill-throws', 44444);
    const { manager, calls } = makeManager();
    const killSpy = vi.fn(() => {
      throw new Error('taskkill missing');
    });
    const onError = vi.fn();

    const watcher = watchPtyHostChildLifecycle(handle, {
      manager,
      killSubtree: killSpy,
      onError,
    });

    handle.resolveExit({ reason: 'crashed', code: 1, signal: null });
    // The watcher must not reject even though the killer threw.
    await expect(watcher.done()).resolves.toEqual({
      reason: 'crashed',
      code: 1,
      signal: null,
    });

    expect(calls).toEqual([
      { id: 'sess-kill-throws', reason: 'crashed', exit_code: 1 },
    ]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe('kill');
  });

  it('still resolves done() if markEnded throws (markEnded error is reported, not propagated)', async () => {
    const handle = makeHandle('sess-mark-throws', 55555);
    const onError = vi.fn();
    const manager: Pick<ISessionManager, 'markEnded'> = {
      markEnded(): never {
        throw new Error('row missing');
      },
    };

    const watcher = watchPtyHostChildLifecycle(handle, {
      manager,
      killSubtree: vi.fn(),
      onError,
    });

    handle.resolveExit({ reason: 'crashed', code: 2, signal: null });
    await expect(watcher.done()).resolves.toBeDefined();

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]![0]).toBe('markEnded');
  });
});

describe('watchPtyHostChildLifecycle — wiring', () => {
  it('uses the production killProcessSubtree when killSubtree dep is omitted (smoke)', async () => {
    // We cannot actually kill a real process from a unit test, so we
    // route the watcher to a child pid that does not exist (1) — the
    // real `killProcessSubtree` swallows ESRCH so this is safe and
    // proves the default wiring resolves to a callable function.
    const handle = makeHandle('sess-default-killer', 1);
    const { manager, calls } = makeManager();

    const watcher = watchPtyHostChildLifecycle(handle, { manager });
    handle.resolveExit({ reason: 'graceful', code: 0, signal: null });
    await watcher.done();

    expect(calls).toHaveLength(1);
  });
});
