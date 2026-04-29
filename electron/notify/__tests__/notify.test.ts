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
  names?: Record<string, string>;
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
  const names = opts?.names ?? {};
  harness.dispose = installNotifyBridge({
    sessionWatcher: emitter,
    getMainWindow: () => null,
    isMutedFn: () => harness.isMuted,
    getActiveSidFn: () => harness.activeSid,
    isWindowFocusedFn: () => harness.windowFocused,
    notifyImpl: harness.notifyImpl,
    getNameFn: (sid) => names[sid] ?? null,
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

  it('still fires when window is focused but a DIFFERENT sid is active', () => {
    const h = makeHarness({ windowFocused: true, activeSid: 'sid-other' });
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

  describe('name resolution in body', () => {
    // The bug we're fixing: pre-fix, the body always interpolated the short
    // sid prefix, so users saw "1a2b3c4d completed its task" instead of the
    // friendly name they renamed the session to.

    it('uses the friendly name from getNameFn when present', () => {
      const sid = '11112222-aaaa-bbbb-cccc-deadbeefcafe';
      const h = makeHarness({ names: { [sid]: 'my-feature' } });
      emit(h.emitter, { sid, state: 'idle' });
      expect(h.log).toHaveLength(1);
      // Body must contain the friendly name, NOT the sid prefix.
      expect(h.log[0].body).toContain('my-feature');
      expect(h.log[0].body).not.toContain('11112222');
      h.dispose();
    });

    it('falls back to short sid when name missing', () => {
      const sid = 'deadbeef-1111-2222-3333-444455556666';
      const h = makeHarness();
      emit(h.emitter, { sid, state: 'idle' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('deadbeef');
      h.dispose();
    });

    it('falls back to short sid when name is the "New session" placeholder', () => {
      const sid = 'cafebabe-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: 'New session' } });
      emit(h.emitter, { sid, state: 'idle' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('cafebabe');
      expect(h.log[0].body).not.toContain('New session');
      h.dispose();
    });

    it('falls back to short sid when name is the Chinese placeholder', () => {
      const sid = 'feedface-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: '新会话' } });
      emit(h.emitter, { sid, state: 'idle' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('feedface');
      h.dispose();
    });

    it('falls back to short sid when name is empty/whitespace', () => {
      const sid = '0badc0de-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: '   ' } });
      emit(h.emitter, { sid, state: 'idle' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('0badc0de');
      h.dispose();
    });

    it('uses friendly name for requires_action body too', () => {
      const sid = '99998888-aaaa-bbbb-cccc-eeee11112222';
      const h = makeHarness({ names: { [sid]: 'fix-bug-602' } });
      emit(h.emitter, { sid, state: 'requires_action' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('fix-bug-602');
      expect(h.log[0].body).not.toContain('99998888');
      h.dispose();
    });
  });
});
