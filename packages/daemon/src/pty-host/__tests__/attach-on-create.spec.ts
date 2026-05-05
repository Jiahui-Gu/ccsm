// packages/daemon/src/pty-host/__tests__/attach-on-create.spec.ts
//
// Unit tests for `decodeSpawnPayload` and `makeProductionAttachPtyHost`
// (Task #436 coverage sweep). The decoder is pure; the factory is wired by
// stubbing `spawnPtyHostChild` and `watchPtyHostChildLifecycle` via vi.mock.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SessionRow } from '../../sessions/types.js';
import { SessionState } from '../../sessions/types.js';
import type { PtyHostChildHandle } from '../host.js';
import type { ChildExit } from '../types.js';

// vi.mock must be hoisted; we expose the spy through a named export.
const spawnSpy = vi.fn();
const watchSpy = vi.fn();

vi.mock('../host.js', () => ({
  spawnPtyHostChild: (opts: unknown) => spawnSpy(opts),
}));

vi.mock('../lifecycle-watcher.js', () => ({
  watchPtyHostChildLifecycle: (handle: unknown, deps: unknown) =>
    watchSpy(handle, deps),
}));

// Imports MUST come AFTER vi.mock so the mocked modules are wired in.
const {
  decodeSpawnPayload,
  makeProductionAttachPtyHost,
} = await import('../attach-on-create.js');

function makeRow(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: 's-1',
    owner_id: 'u-1',
    state: SessionState.STARTING,
    cwd: '/tmp/cwd',
    env_json: '{}',
    claude_args_json: '[]',
    geometry_cols: 80,
    geometry_rows: 24,
    exit_code: 0,
    created_ms: 1,
    last_active_ms: 1,
    should_be_running: 1,
    ...overrides,
  };
}

let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  spawnSpy.mockReset();
  watchSpy.mockReset();
  consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  consoleErrorSpy.mockRestore();
});

describe('decodeSpawnPayload — pure decoder', () => {
  it('parses env_json into envExtra (string-only entries)', () => {
    const row = makeRow({
      env_json: JSON.stringify({ FOO: 'bar', NOT_STRING: 42 }),
      claude_args_json: JSON.stringify(['--model', 'sonnet']),
    });
    const payload = decodeSpawnPayload(row);
    expect(payload.sessionId).toBe('s-1');
    expect(payload.cwd).toBe('/tmp/cwd');
    expect(payload.cols).toBe(80);
    expect(payload.rows).toBe(24);
    expect(payload.envExtra).toEqual({ FOO: 'bar' }); // 42 dropped
    expect(payload.claudeArgs).toEqual(['--model', 'sonnet']);
  });

  it('falls back to undefined envExtra on malformed env_json', () => {
    const row = makeRow({ env_json: '{not json' });
    const payload = decodeSpawnPayload(row);
    expect(payload.envExtra).toBeUndefined();
  });

  it('falls back to undefined envExtra when env_json parses to null', () => {
    const row = makeRow({ env_json: 'null' });
    const payload = decodeSpawnPayload(row);
    expect(payload.envExtra).toBeUndefined();
  });

  it('falls back to undefined envExtra when env_json parses to an array', () => {
    const row = makeRow({ env_json: '[1, 2]' });
    const payload = decodeSpawnPayload(row);
    expect(payload.envExtra).toBeUndefined();
  });

  it('falls back to [] claudeArgs on malformed claude_args_json', () => {
    const row = makeRow({ claude_args_json: '{bad' });
    const payload = decodeSpawnPayload(row);
    expect(payload.claudeArgs).toEqual([]);
  });

  it('filters non-string entries from claude_args_json', () => {
    const row = makeRow({
      claude_args_json: JSON.stringify(['--ok', 99, null, '--also-ok']),
    });
    const payload = decodeSpawnPayload(row);
    expect(payload.claudeArgs).toEqual(['--ok', '--also-ok']);
  });

  it('falls back to [] when claude_args_json parses to a non-array', () => {
    const row = makeRow({ claude_args_json: '{"not":"array"}' });
    const payload = decodeSpawnPayload(row);
    expect(payload.claudeArgs).toEqual([]);
  });
});

describe('makeProductionAttachPtyHost — factory glue', () => {
  function fakeHandle(): PtyHostChildHandle {
    let resolveReady: () => void = () => {};
    const ready = new Promise<void>((res) => {
      resolveReady = res;
    });
    const exited = new Promise<ChildExit>(() => {});
    const handle = {
      sessionId: 's-1',
      pid: 1234,
      claudeSpawnEnv: {},
      ready: () => ready,
      send: vi.fn(),
      exited: () => exited,
      messages: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.resolve({ value: undefined, done: true as const }) };
        },
      }),
      closeAndWait: () => exited,
      _resolveReady: resolveReady,
    } as PtyHostChildHandle & { _resolveReady: () => void };
    return handle;
  }

  it('spawns + installs the watcher and returns the handle', () => {
    const handle = fakeHandle();
    spawnSpy.mockReturnValue(handle);

    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
    });

    const row = makeRow();
    const out = attach(row);
    expect(out).toBe(handle);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    expect(watchSpy).toHaveBeenCalledTimes(1);
  });

  it('sends `spawn` IPC after handle.ready() resolves', async () => {
    const handle = fakeHandle() as PtyHostChildHandle & { _resolveReady: () => void };
    spawnSpy.mockReturnValue(handle);

    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
    });

    attach(makeRow());

    // Until ready resolves, send must not have been called.
    expect(handle.send).not.toHaveBeenCalled();

    handle._resolveReady();
    // Flush microtasks
    await new Promise((r) => setImmediate(r));

    expect(handle.send).toHaveBeenCalledWith({
      kind: 'spawn',
      payload: expect.objectContaining({ sessionId: 's-1' }),
    });
  });

  it('routes a spawn throw to onError and returns null', () => {
    spawnSpy.mockImplementation(() => {
      throw new Error('fork failed');
    });
    const onError = vi.fn();
    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
      onError,
    });
    const out = attach(makeRow());
    expect(out).toBeNull();
    expect(onError).toHaveBeenCalledWith('spawn', expect.any(Error));
    expect(watchSpy).not.toHaveBeenCalled();
  });

  it('default onError logs to console.error with [ccsm-daemon] prefix', () => {
    spawnSpy.mockImplementation(() => {
      throw new Error('fork failed');
    });
    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
    });
    expect(attach(makeRow())).toBeNull();
    expect(consoleErrorSpy).toHaveBeenCalled();
    const firstArg = consoleErrorSpy.mock.calls[0][0] as string;
    expect(firstArg).toContain('[ccsm-daemon]');
    expect(firstArg).toContain('spawn');
  });

  it('routes a send-spawn throw to onError after ready resolves', async () => {
    const handle = fakeHandle() as PtyHostChildHandle & { _resolveReady: () => void };
    (handle.send as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('channel closed');
    });
    spawnSpy.mockReturnValue(handle);
    const onError = vi.fn();
    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
      onError,
    });
    attach(makeRow());
    handle._resolveReady();
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledWith('send-spawn', expect.any(Error));
  });

  it('routes a ready() rejection (early exit) to onError as send-spawn', async () => {
    const handle = {
      sessionId: 's-1',
      pid: 1,
      claudeSpawnEnv: {},
      ready: () => Promise.reject(new Error('child exited before ready')),
      send: vi.fn(),
      exited: () => new Promise<ChildExit>(() => {}),
      messages: () => ({
        [Symbol.asyncIterator]() {
          return { next: () => Promise.resolve({ value: undefined, done: true as const }) };
        },
      }),
      closeAndWait: () => new Promise<ChildExit>(() => {}),
    } as PtyHostChildHandle;
    spawnSpy.mockReturnValue(handle);
    const onError = vi.fn();
    const attach = makeProductionAttachPtyHost({
      manager: { markEnded: vi.fn() },
      onError,
    });
    attach(makeRow());
    await new Promise((r) => setImmediate(r));
    expect(onError).toHaveBeenCalledWith('send-spawn', expect.any(Error));
  });
});
