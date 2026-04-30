// Tests for installNotifyPipelineWithProducers — the bootstrap that wires
// the Electron app + ptyHost + sessionWatcher producers into the
// notify pipeline. Extracted from main.ts in Task #742.
//
// We mock the four boundary modules so the test runs in plain Node:
//   * electron (app + BrowserWindow)
//   * ../sinks/pipeline (recording installNotifyPipeline)
//   * ../../ptyHost (onPtyData subscriber capture)
//   * ../../sessionWatcher (sessionWatcher EventEmitter capture)
//
// Each test then triggers a producer and asserts the corresponding
// pipeline method was called — i.e. real wiring, not mock-of-mock.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';

interface AppEmitter {
  on: (evt: string, cb: () => void) => void;
  _trigger: (evt: string) => void;
}

// Hoisted refs so vi.mock factories (which run before imports) can see them.
// watcherEmitter starts null and is constructed in beforeEach using the
// top-level EventEmitter import (vi.hoisted runs before top-level imports).
const h = vi.hoisted(() => {
  return {
    appHandlers: new Map<string, Array<() => void>>(),
    allWindowsRef: {
      current: [] as Array<{ isDestroyed: () => boolean; isFocused: () => boolean }>,
    },
    ptyDataCb: { current: null as null | ((sid: string, chunk: string | Buffer) => void) },
    watcherEmitter: null as null | EventEmitter,
    lastPipeline: { current: null as null | RecordingPipelineLike },
  };
});

interface RecordingPipelineLike {
  feedChunk: ReturnType<typeof vi.fn>;
  setFocused: ReturnType<typeof vi.fn>;
  forgetSid: ReturnType<typeof vi.fn>;
  markUserInput: ReturnType<typeof vi.fn>;
  setActiveSid: ReturnType<typeof vi.fn>;
  setMuted: ReturnType<typeof vi.fn>;
  dispose: ReturnType<typeof vi.fn>;
  _internals: ReturnType<typeof vi.fn>;
  _opts?: unknown;
}

vi.mock('electron', () => {
  const app: AppEmitter = {
    on(evt, cb) {
      const arr = h.appHandlers.get(evt) ?? [];
      arr.push(cb);
      h.appHandlers.set(evt, arr);
    },
    _trigger(evt) {
      for (const cb of h.appHandlers.get(evt) ?? []) cb();
    },
  };
  const BrowserWindow = {
    getAllWindows: () => h.allWindowsRef.current,
  };
  return { app, BrowserWindow };
});

vi.mock('../../sinks/pipeline', () => ({
  installNotifyPipeline: (opts: unknown) => {
    const p: RecordingPipelineLike = {
      feedChunk: vi.fn(),
      setFocused: vi.fn(),
      forgetSid: vi.fn(),
      markUserInput: vi.fn(),
      setActiveSid: vi.fn(),
      setMuted: vi.fn(),
      dispose: vi.fn(),
      _internals: vi.fn(),
      _opts: opts,
    };
    h.lastPipeline.current = p;
    return p;
  },
}));

vi.mock('../../../ptyHost', () => ({
  onPtyData: (cb: (sid: string, chunk: string | Buffer) => void) => {
    h.ptyDataCb.current = cb;
  },
}));

vi.mock('../../../sessionWatcher', () => ({
  get sessionWatcher() {
    return h.watcherEmitter;
  },
}));

import { installNotifyPipelineWithProducers } from '../installPipeline';

beforeEach(() => {
  h.appHandlers.clear();
  h.allWindowsRef.current = [];
  h.ptyDataCb.current = null;
  h.watcherEmitter = new EventEmitter();
  h.lastPipeline.current = null;
});

describe('installNotifyPipelineWithProducers', () => {
  it('forwards constructor deps (getNameFn, isGlobalMutedFn, onNotified) to installNotifyPipeline', () => {
    const getNameFn = (sid: string) => `name-${sid}`;
    const isGlobalMutedFn = () => true;
    const onNotified = vi.fn();
    installNotifyPipelineWithProducers({ getNameFn, isGlobalMutedFn, onNotified });

    const opts = h.lastPipeline.current!._opts as {
      getNameFn: (sid: string) => string | null;
      isGlobalMutedFn: () => boolean;
      onNotified: (sid: string) => void;
      getMainWindow: () => unknown;
    };
    expect(opts.getNameFn('abc')).toBe('name-abc');
    expect(opts.isGlobalMutedFn()).toBe(true);
    opts.onNotified('s1');
    expect(onNotified).toHaveBeenCalledWith('s1');
  });

  it('getMainWindow returns the first window or null', () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    const opts = h.lastPipeline.current!._opts as { getMainWindow: () => unknown };
    expect(opts.getMainWindow()).toBeNull();
    const w = { isDestroyed: () => false, isFocused: () => true };
    h.allWindowsRef.current = [w];
    expect(opts.getMainWindow()).toBe(w);
  });

  it('PTY data is forwarded to pipeline.feedChunk(sid, chunk)', () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    expect(h.ptyDataCb.current).not.toBeNull();
    h.ptyDataCb.current!('s1', 'hello');
    expect(h.lastPipeline.current!.feedChunk).toHaveBeenCalledWith('s1', 'hello');
    const buf = Buffer.from([1, 2, 3]);
    h.ptyDataCb.current!('s2', buf);
    expect(h.lastPipeline.current!.feedChunk).toHaveBeenLastCalledWith('s2', buf);
  });

  it('browser-window-focus forwards setFocused(true)', () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    (h.appHandlers.get('browser-window-focus') ?? [])[0]!();
    expect(h.lastPipeline.current!.setFocused).toHaveBeenCalledWith(true);
  });

  it('browser-window-blur forwards setFocused with the result of any-window-focused check', () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    h.allWindowsRef.current = [
      { isDestroyed: () => false, isFocused: () => false },
    ];
    (h.appHandlers.get('browser-window-blur') ?? [])[0]!();
    expect(h.lastPipeline.current!.setFocused).toHaveBeenLastCalledWith(false);

    h.allWindowsRef.current = [
      { isDestroyed: () => false, isFocused: () => true },
    ];
    (h.appHandlers.get('browser-window-blur') ?? [])[0]!();
    expect(h.lastPipeline.current!.setFocused).toHaveBeenLastCalledWith(true);

    h.allWindowsRef.current = [
      { isDestroyed: () => true, isFocused: () => true },
    ];
    (h.appHandlers.get('browser-window-blur') ?? [])[0]!();
    expect(h.lastPipeline.current!.setFocused).toHaveBeenLastCalledWith(false);
  });

  it("sessionWatcher 'unwatched' event forwards forgetSid for the sid", () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    h.watcherEmitter.emit('unwatched', { sid: 's1' });
    expect(h.lastPipeline.current!.forgetSid).toHaveBeenCalledWith('s1');
  });

  it("sessionWatcher 'unwatched' is a no-op for malformed payloads", () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    h.watcherEmitter.emit('unwatched', undefined);
    h.watcherEmitter.emit('unwatched', null);
    h.watcherEmitter.emit('unwatched', {});
    h.watcherEmitter.emit('unwatched', { sid: 123 });
    h.watcherEmitter.emit('unwatched', { sid: '' });
    expect(h.lastPipeline.current!.forgetSid).not.toHaveBeenCalled();
  });

  // audit #876 H2: when a session is unwatched, the badge unread counter
  // for that sid must be drained too. Without this fan-out the badge
  // store accumulated entries forever — every notified sid stayed counted
  // for the app lifetime even after the session was deleted.
  it("sessionWatcher 'unwatched' forwards onUnwatchedSid for badge drain", () => {
    const onUnwatchedSid = vi.fn();
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
      onUnwatchedSid,
    });
    h.watcherEmitter.emit('unwatched', { sid: 's1' });
    expect(onUnwatchedSid).toHaveBeenCalledWith('s1');
    expect(h.lastPipeline.current!.forgetSid).toHaveBeenCalledWith('s1');
  });

  // audit #876 Item 5 (Task #897): main.ts holds a sessionNamesFromRenderer
  // Map that the renderer pushes into via session:setName IPC. Without a
  // drain in onUnwatchedSid, every renamed session leaks its entry forever.
  // This test mirrors the main.ts wiring (a real Map + a delete in the
  // onUnwatchedSid callback) to lock the contract end-to-end.
  it("sessionWatcher 'unwatched' lets caller drain a per-sid Map (sessionNamesFromRenderer)", () => {
    const sessionNamesFromRenderer = new Map<string, string>();
    sessionNamesFromRenderer.set('sid-x', 'name-x');
    installNotifyPipelineWithProducers({
      getNameFn: (sid) => sessionNamesFromRenderer.get(sid) ?? null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
      onUnwatchedSid: (sid) => {
        sessionNamesFromRenderer.delete(sid);
      },
    });
    expect(sessionNamesFromRenderer.has('sid-x')).toBe(true);
    h.watcherEmitter.emit('unwatched', { sid: 'sid-x' });
    expect(sessionNamesFromRenderer.has('sid-x')).toBe(false);
  });

  it("sessionWatcher 'unwatched' does not invoke onUnwatchedSid for malformed payloads", () => {
    const onUnwatchedSid = vi.fn();
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
      onUnwatchedSid,
    });
    h.watcherEmitter.emit('unwatched', undefined);
    h.watcherEmitter.emit('unwatched', null);
    h.watcherEmitter.emit('unwatched', {});
    h.watcherEmitter.emit('unwatched', { sid: 123 });
    h.watcherEmitter.emit('unwatched', { sid: '' });
    expect(onUnwatchedSid).not.toHaveBeenCalled();
  });

  it('omitting onUnwatchedSid is allowed (optional dep)', () => {
    installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    expect(() => h.watcherEmitter.emit('unwatched', { sid: 's1' })).not.toThrow();
    expect(h.lastPipeline.current!.forgetSid).toHaveBeenCalledWith('s1');
  });

  it('returns the live pipeline instance', () => {
    const ret = installNotifyPipelineWithProducers({
      getNameFn: () => null,
      isGlobalMutedFn: () => false,
      onNotified: () => {},
    });
    expect(ret).toBe(h.lastPipeline.current);
  });
});
