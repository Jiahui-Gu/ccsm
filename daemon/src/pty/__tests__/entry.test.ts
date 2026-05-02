// Tests for daemon-side per-session PTY entry factory (Task #108).
//
// Pinned behaviour:
//   - dispatchPtyChunk bumps seq before each fan-out + writes to
//     headless atomically (single-threaded JS guarantee).
//   - makeEntry calls registerChildPid with the freshly-spawned PID.
//   - PTY exit triggers the onExit hook with translated signal name.
//   - Caller-supplied env is forwarded to pty.spawn.
//
// The full lifecycle integration is tested in registry.test.ts; this
// file covers the pure factory + dispatch logic in isolation.

import { describe, expect, it, vi } from 'vitest';
import type * as pty from 'node-pty';
import { dispatchPtyChunk, makeEntry, type Entry } from '../entry.js';
import { createFanoutRegistry } from '../fanout-registry.js';
import type { PtySubscribeFrame } from '../../handlers/pty-subscribe.js';

function makeStubPty(): pty.IPty & {
  emitData: (s: string) => void;
  emitExit: (code: number, signal?: number) => void;
} {
  let dataCb: ((s: string) => void) | undefined;
  let exitCb: ((e: { exitCode: number; signal?: number }) => void) | undefined;
  return {
    pid: 4242,
    cols: 80,
    rows: 24,
    process: 'stub',
    handleFlowControl: false,
    onData: (cb: (s: string) => void) => {
      dataCb = cb;
      return { dispose: () => undefined };
    },
    onExit: (cb: (e: { exitCode: number; signal?: number }) => void) => {
      exitCb = cb;
      return { dispose: () => undefined };
    },
    write: () => undefined,
    resize: () => undefined,
    kill: () => undefined,
    pause: () => undefined,
    resume: () => undefined,
    clear: () => undefined,
    emitData: (s: string) => dataCb?.(s),
    emitExit: (code: number, signal?: number) =>
      exitCb?.({ exitCode: code, ...(signal !== undefined ? { signal } : {}) }),
  } as unknown as pty.IPty & {
    emitData: (s: string) => void;
    emitExit: (code: number, signal?: number) => void;
  };
}

describe('pty/entry.dispatchPtyChunk', () => {
  it('bumps seq atomically + fans out + writes to headless', () => {
    const fanout = createFanoutRegistry<PtySubscribeFrame>();
    const headlessWrite = vi.fn();
    const fakeEntry = {
      sid: 'sid-x',
      seq: 0,
      headless: { write: headlessWrite },
    } as unknown as Entry;

    const received: PtySubscribeFrame[] = [];
    fanout.subscribe('sid-x', {
      deliver: (f) => received.push(f),
      close: () => undefined,
    });

    dispatchPtyChunk(fakeEntry, 'abc', fanout);
    dispatchPtyChunk(fakeEntry, 'd', fanout);

    expect(fakeEntry.seq).toBe(2);
    expect(headlessWrite).toHaveBeenCalledTimes(2);
    expect(headlessWrite.mock.calls[0]?.[0]).toBe('abc');
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({ kind: 'delta', seq: 1 });
    expect(received[1]).toMatchObject({ kind: 'delta', seq: 2 });
  });

  it('logs + continues when headless.write throws (broadcast still runs)', () => {
    const fanout = createFanoutRegistry<PtySubscribeFrame>();
    const fakeEntry = {
      sid: 'sid-x',
      seq: 0,
      headless: {
        write: () => {
          throw new Error('boom');
        },
      },
    } as unknown as Entry;
    const warn = vi.fn();
    const received: PtySubscribeFrame[] = [];
    fanout.subscribe('sid-x', {
      deliver: (f) => received.push(f),
      close: () => undefined,
    });
    expect(() => dispatchPtyChunk(fakeEntry, 'x', fanout, { warn })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    expect(received).toHaveLength(1);
  });
});

describe('pty/entry.makeEntry', () => {
  it('registers PID + forwards env + onExit translates signal to SIGn', () => {
    const stub = makeStubPty();
    const fanout = createFanoutRegistry<PtySubscribeFrame>();
    const registerChildPid = vi.fn();
    const onExit = vi.fn();
    const seenEnv: Record<string, string>[] = [];

    const entry = makeEntry(
      {
        sid: 'sid-1',
        command: 'fake',
        args: [],
        cwd: '/tmp',
        env: { CUSTOM: '1' } as NodeJS.ProcessEnv,
      },
      {
        fanoutRegistry: fanout,
        registerChildPid,
        onExit,
        spawn: ((_cmd: string, _args: string[], opts: { env?: Record<string, string> }) => {
          if (opts.env) seenEnv.push(opts.env);
          return stub as unknown as pty.IPty;
        }) as unknown as typeof pty.spawn,
      },
    );

    expect(entry.pid).toBe(4242);
    expect(registerChildPid).toHaveBeenCalledWith('sid-1', 4242);
    expect(seenEnv[0]).toEqual({ CUSTOM: '1' });

    stub.emitExit(0, 15);
    expect(onExit).toHaveBeenCalledWith('sid-1', 4242, 0, 'SIG15');
    expect(entry.exited).toBe(true);
  });
});
