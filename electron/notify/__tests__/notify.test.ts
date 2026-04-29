import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EventEmitter } from 'node:events';

// `installNotifyBridge` imports `tNotification` from `../i18n` (real module —
// no mock needed; it's pure string interpolation) and Electron's
// `Notification` (we never reach it because we always inject `notifyImpl`).
// The Electron import still resolves — vi mock keeps the test environment
// from pulling the real native module.
vi.mock('electron', () => ({
  Notification: class FakeNotification {
    static isSupported(): boolean { return true; }
    on(): this { return this; }
    show(): void { /* never called — tests inject notifyImpl */ }
  },
}));

import { installNotifyBridge, type NotifyImpl, type NotifyPayload } from '../index';

type StateEvt = { sid: string; state: 'idle' | 'running' | 'requires_action' };

interface Harness {
  emitter: EventEmitter;
  log: NotifyPayload[];
  clickHandlers: Array<() => void>;
  notifyImpl: NotifyImpl;
  isMuted: boolean;
  activeSid: string | null;
  windowFocused: boolean;
  dispose: () => void;
}

function makeHarness(opts?: {
  isMuted?: boolean;
  activeSid?: string | null;
  windowFocused?: boolean;
}): Harness {
  const emitter = new EventEmitter();
  const log: NotifyPayload[] = [];
  const clickHandlers: Array<() => void> = [];
  const harness: Harness = {
    emitter,
    log,
    clickHandlers,
    notifyImpl: {
      show(payload, onClick) {
        log.push(payload);
        clickHandlers.push(onClick);
      },
    },
    isMuted: opts?.isMuted ?? false,
    activeSid: opts?.activeSid ?? null,
    windowFocused: opts?.windowFocused ?? false,
    dispose: () => { /* replaced below */ },
  };
  harness.dispose = installNotifyBridge({
    sessionWatcher: emitter,
    getMainWindow: () => null,
    isMutedFn: () => harness.isMuted,
    getActiveSidFn: () => harness.activeSid,
    isWindowFocusedFn: () => harness.windowFocused,
    notifyImpl: harness.notifyImpl,
  });
  return harness;
}

function emit(emitter: EventEmitter, evt: StateEvt): void {
  emitter.emit('state-changed', evt);
}

describe('installNotifyBridge', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('fires on transition to idle', () => {
    const h = makeHarness();
    emit(h.emitter, { sid: 'sid-1', state: 'idle' });
    expect(h.log).toHaveLength(1);
    expect(h.log[0].state).toBe('idle');
    expect(h.log[0].sid).toBe('sid-1');
    expect(h.log[0].title).toBeTruthy();
    expect(h.log[0].body).toBeTruthy();
    h.dispose();
  });

  it('fires on transition to requires_action', () => {
    const h = makeHarness();
    emit(h.emitter, { sid: 'sid-2', state: 'requires_action' });
    expect(h.log).toHaveLength(1);
    expect(h.log[0].state).toBe('requires_action');
    h.dispose();
  });

  it('does NOT fire for running state', () => {
    const h = makeHarness();
    emit(h.emitter, { sid: 'sid-3', state: 'running' });
    expect(h.log).toHaveLength(0);
    h.dispose();
  });

  it('suppresses when global mute is on', () => {
    const h = makeHarness({ isMuted: true });
    emit(h.emitter, { sid: 'sid-4', state: 'idle' });
    expect(h.log).toHaveLength(0);
    // Toggle mute off — next event fires.
    h.isMuted = false;
    emit(h.emitter, { sid: 'sid-4-b', state: 'idle' });
    expect(h.log).toHaveLength(1);
    h.dispose();
  });

  it('suppresses when window focused AND active sid matches the target', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-5' });
    emit(h.emitter, { sid: 'sid-5', state: 'idle' });
    expect(h.log).toHaveLength(0);
    h.dispose();
  });

  it('suppresses when window focused even if a DIFFERENT sid is active (#611)', () => {
    // App-level suppression: if the user is in the ccsm app, no OS toast
    // for any session. The in-app sidebar dot / icon-flash bridge handle
    // surfacing the event in-app.
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.log).toHaveLength(0);
    h.dispose();
  });

  it('suppresses when window focused with no active sid (#611)', () => {
    const h = makeHarness({ windowFocused: true, activeSid: null });
    emit(h.emitter, { sid: 'sid-x', state: 'requires_action' });
    expect(h.log).toHaveLength(0);
    h.dispose();
  });

  it('fires when window NOT focused and a different sid transitions', () => {
    const h = makeHarness({ windowFocused: false, activeSid: 'sid-other' });
    emit(h.emitter, { sid: 'sid-target', state: 'idle' });
    expect(h.log).toHaveLength(1);
    expect(h.log[0].sid).toBe('sid-target');
    h.dispose();
  });

  it('still fires when active sid matches but window is NOT focused', () => {
    // User minimised / switched apps with that session active. They want the
    // ping, otherwise they'd never know it finished.
    const h = makeHarness({ windowFocused: false, activeSid: 'sid-bg' });
    emit(h.emitter, { sid: 'sid-bg', state: 'idle' });
    expect(h.log).toHaveLength(1);
    h.dispose();
  });

  it('dedupes a second event for the same sid within 5s', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    emit(h.emitter, { sid: 'sid-dd', state: 'idle' });
    expect(h.log).toHaveLength(1);
    // Within window — suppressed.
    vi.advanceTimersByTime(2_000);
    emit(h.emitter, { sid: 'sid-dd', state: 'requires_action' });
    expect(h.log).toHaveLength(1);
    // After window — fires again.
    vi.advanceTimersByTime(4_000);
    emit(h.emitter, { sid: 'sid-dd', state: 'idle' });
    expect(h.log).toHaveLength(2);
    h.dispose();
  });

  it('dedupe is per-sid (different sids both fire within window)', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    emit(h.emitter, { sid: 'sid-A', state: 'idle' });
    vi.advanceTimersByTime(500);
    emit(h.emitter, { sid: 'sid-B', state: 'idle' });
    expect(h.log).toHaveLength(2);
    h.dispose();
  });

  it('reads mute fresh on every event (not cached at install time)', () => {
    const h = makeHarness({ isMuted: true });
    emit(h.emitter, { sid: 'sid-toggle', state: 'idle' });
    expect(h.log).toHaveLength(0);
    h.isMuted = false;
    emit(h.emitter, { sid: 'sid-toggle-2', state: 'idle' });
    expect(h.log).toHaveLength(1);
    h.dispose();
  });

  it('dispose stops further notifications', () => {
    const h = makeHarness();
    h.dispose();
    emit(h.emitter, { sid: 'sid-after-dispose', state: 'idle' });
    expect(h.log).toHaveLength(0);
  });

  it('ignores malformed events', () => {
    const h = makeHarness();
    // Missing sid.
    emit(h.emitter, { sid: '', state: 'idle' });
    // @ts-expect-error — testing runtime guard against null payload
    h.emitter.emit('state-changed', null);
    expect(h.log).toHaveLength(0);
    h.dispose();
  });
});
