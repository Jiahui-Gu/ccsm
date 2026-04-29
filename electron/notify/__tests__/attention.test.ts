import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// `attention.ts` imports `app` and a `BrowserWindow` type from electron.
// Tests always inject `attentionImpl`, so the production paths that touch
// `app.dock` / `win.flashFrame` are never reached. The mock prevents the
// native module from loading in the vitest environment.
vi.mock('electron', () => ({
  app: {
    dock: {
      bounce: () => 1,
      cancelBounce: () => { /* noop */ },
    },
  },
}));

import {
  installAttentionFlash,
  type AttentionImpl,
  type AttentionEvent,
} from '../attention';

type StateEvt = { sid: string; state: 'idle' | 'running' | 'requires_action' };

interface FlashCall {
  payload: AttentionEvent;
  handle: number | null;
}

interface CancelCall {
  handle: number | null;
}

interface Harness {
  emitter: EventEmitter;
  flashes: FlashCall[];
  cancels: CancelCall[];
  attentionImpl: AttentionImpl;
  isMuted: boolean;
  activeSid: string | null;
  windowFocused: boolean;
  dispose: () => void;
  cancel: () => void;
}

function makeHarness(opts?: {
  isMuted?: boolean;
  activeSid?: string | null;
  windowFocused?: boolean;
  /** When set, flash() returns this id (default: monotonically increasing). */
  forceHandle?: number;
}): Harness {
  const emitter = new EventEmitter();
  const flashes: FlashCall[] = [];
  const cancels: CancelCall[] = [];
  let nextId = 100;

  const harness: Harness = {
    emitter,
    flashes,
    cancels,
    attentionImpl: {
      flash(payload) {
        const handle = opts?.forceHandle ?? nextId++;
        // Mark kind so the install fn doesn't take the real flashFrame
        // branch — "dockBounce" path is a pure no-op outside the impl.
        payload.kind = 'dockBounce';
        flashes.push({ payload, handle });
        return handle;
      },
      cancel(handle, _win) {
        cancels.push({ handle });
      },
    },
    isMuted: opts?.isMuted ?? false,
    activeSid: opts?.activeSid ?? null,
    windowFocused: opts?.windowFocused ?? true,
    dispose: () => { /* replaced */ },
    cancel: () => { /* replaced */ },
  };

  const inst = installAttentionFlash({
    sessionWatcher: emitter,
    getMainWindow: () => null,
    isMutedFn: () => harness.isMuted,
    getActiveSidFn: () => harness.activeSid,
    isWindowFocusedFn: () => harness.windowFocused,
    attentionImpl: harness.attentionImpl,
  });
  harness.dispose = inst.dispose;
  harness.cancel = inst.cancel;
  return harness;
}

function emit(emitter: EventEmitter, evt: StateEvt): void {
  emitter.emit('state-changed', evt);
}

describe('installAttentionFlash', () => {
  it('flashes when focused + non-active sid + idle', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.flashes).toHaveLength(1);
    expect(h.flashes[0].payload.sid).toBe('sid-target');
    expect(h.flashes[0].payload.state).toBe('idle');
    h.dispose();
  });

  it('flashes when focused + non-active sid + requires_action', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-x', state: 'requires_action' });
    expect(h.flashes).toHaveLength(1);
    expect(h.flashes[0].payload.state).toBe('requires_action');
    h.dispose();
  });

  it('does NOT flash when focused + the active sid is the target', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-target' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.flashes).toHaveLength(0);
    h.dispose();
  });

  it('does NOT flash when window is unfocused (notify path handles it)', () => {
    const h = makeHarness({ windowFocused: false, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.flashes).toHaveLength(0);
    h.dispose();
  });

  it('does NOT flash when muted', () => {
    const h = makeHarness({ windowFocused: true, isMuted: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.flashes).toHaveLength(0);
    h.dispose();
  });

  it('does NOT flash for running state', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'running' });
    expect(h.flashes).toHaveLength(0);
    h.dispose();
  });

  it('cancel() cancels the pending bounce handle', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other', forceHandle: 42 });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.flashes).toHaveLength(1);
    h.cancel();
    expect(h.cancels).toHaveLength(1);
    expect(h.cancels[0].handle).toBe(42);
    // Cancel-then-cancel is a no-op (handle slot already cleared).
    h.cancel();
    expect(h.cancels).toHaveLength(2);
    expect(h.cancels[1].handle).toBeNull();
    h.dispose();
  });

  it('a fresh flash supersedes the prior pending handle (cancels old)', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-A', state: 'idle' });
    const firstHandle = h.flashes[0].handle;
    emit(h.emitter, { sid: 'sid-B', state: 'idle' });
    // Second flash should have triggered a cancel of the first handle.
    expect(h.cancels.some((c) => c.handle === firstHandle)).toBe(true);
    expect(h.flashes).toHaveLength(2);
    h.dispose();
  });

  it('reads mute fresh on every event', () => {
    const h = makeHarness({ windowFocused: true, isMuted: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-1', state: 'idle' });
    expect(h.flashes).toHaveLength(0);
    h.isMuted = false;
    emit(h.emitter, { sid: 'sid-2', state: 'idle' });
    expect(h.flashes).toHaveLength(1);
    h.dispose();
  });

  it('dispose stops further flashes and cancels pending', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-1', state: 'idle' });
    expect(h.flashes).toHaveLength(1);
    h.dispose();
    emit(h.emitter, { sid: 'sid-2', state: 'idle' });
    expect(h.flashes).toHaveLength(1);
    // Dispose called cancel on the still-pending handle.
    expect(h.cancels.length).toBeGreaterThanOrEqual(1);
  });

  it('ignores malformed events', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: '', state: 'idle' });
    // @ts-expect-error — testing runtime guard
    h.emitter.emit('state-changed', null);
    expect(h.flashes).toHaveLength(0);
    h.dispose();
  });
});
