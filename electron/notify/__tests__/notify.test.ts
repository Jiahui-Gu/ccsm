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
  dispose: () => void;
}

function makeHarness(opts?: {
  isMuted?: boolean;
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
    dispose: () => { /* replaced below */ },
  };
  const names = opts?.names ?? {};
  harness.dispose = installNotifyBridge({
    sessionWatcher: emitter,
    getMainWindow: () => null,
    isMutedFn: () => harness.isMuted,
    notifyImpl: harness.notifyImpl,
    getNameFn: (sid) => names[sid] ?? null,
  });
  return harness;
}

function emit(emitter: EventEmitter, evt: StateEvt): void {
  emitter.emit('state-changed', evt);
}

// Helper: arm + emit idle. Post-#631 the bridge requires a `user-prompt`
// arm signal from the watcher before idle fires; tests that aren't
// specifically testing the arm gate still need to mimic the realistic
// "user typed → CLI replied → idle" flow.
function armAndEmitIdle(emitter: EventEmitter, sid: string): void {
  emitter.emit('user-prompt', { sid });
  emitter.emit('state-changed', { sid, state: 'idle' });
}

describe('installNotifyBridge', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  it('fires on transition to idle', () => {
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-1');
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
    armAndEmitIdle(h.emitter, 'sid-4');
    expect(h.log).toHaveLength(0);
    // Toggle mute off — next event fires.
    h.isMuted = false;
    armAndEmitIdle(h.emitter, 'sid-4-b');
    expect(h.log).toHaveLength(1);
    h.dispose();
  });

  it('fires unconditionally — focus + active sid is NOT a suppression gate', () => {
    // User direction: "完全无差别全通知". Even if the user is staring at this
    // exact session in a focused window, fire the OS notification — they may
    // have the app foreground while looking at their phone.
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-5');
    expect(h.log).toHaveLength(1);
    expect(h.log[0].sid).toBe('sid-5');
    h.dispose();
  });

  it('fires when a different sid is active in a focused window', () => {
    // No focus/active gate: the bridge no longer reads either signal, so this
    // is just another idle-fire path. Asserts the bridge accepts events for
    // sids it has never seen before.
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-target');
    expect(h.log).toHaveLength(1);
    expect(h.log[0].sid).toBe('sid-target');
    h.dispose();
  });

  it('fires regardless of whether the bridge knows about a focused window', () => {
    // Sanity: no focus / activeSid signals are accepted by the options
    // interface anymore; every notify-eligible event fires.
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-bg');
    h.emitter.emit('state-changed', { sid: 'sid-bg-2', state: 'requires_action' });
    expect(h.log).toHaveLength(2);
    h.dispose();
  });

  it('dedupes a second event for the same sid within 5s', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-dd');
    expect(h.log).toHaveLength(1);
    // Within window — RA suppressed by dedupe (would otherwise always fire).
    vi.advanceTimersByTime(2_000);
    emit(h.emitter, { sid: 'sid-dd', state: 'requires_action' });
    expect(h.log).toHaveLength(1);
    // After window — fires again (re-arm + idle).
    vi.advanceTimersByTime(4_000);
    armAndEmitIdle(h.emitter, 'sid-dd');
    expect(h.log).toHaveLength(2);
    h.dispose();
  });

  it('dedupe is per-sid (different sids both fire within window)', () => {
    vi.useFakeTimers();
    const h = makeHarness();
    armAndEmitIdle(h.emitter, 'sid-A');
    vi.advanceTimersByTime(500);
    armAndEmitIdle(h.emitter, 'sid-B');
    expect(h.log).toHaveLength(2);
    h.dispose();
  });

  it('reads mute fresh on every event (not cached at install time)', () => {
    const h = makeHarness({ isMuted: true });
    armAndEmitIdle(h.emitter, 'sid-toggle');
    expect(h.log).toHaveLength(0);
    h.isMuted = false;
    armAndEmitIdle(h.emitter, 'sid-toggle-2');
    expect(h.log).toHaveLength(1);
    h.dispose();
  });

  it('dispose stops further notifications', () => {
    const h = makeHarness();
    h.dispose();
    armAndEmitIdle(h.emitter, 'sid-after-dispose');
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

  describe('arm gate (#631)', () => {
    // Pre-fix: idle always fired (modulo dedupe + mute), so multi-segment
    // turns produced 2+ toasts. Post-fix: idle requires the per-sid armed
    // flag (set via the watcher's `user-prompt` event) to fire.

    it('idle does NOT fire when sid was never armed', () => {
      const h = makeHarness();
      emit(h.emitter, { sid: 'sid-no-arm', state: 'idle' });
      expect(h.log).toHaveLength(0);
      h.dispose();
    });

    it('idle fires once after a `user-prompt` arm and then stops', () => {
      vi.useFakeTimers();
      const h = makeHarness();
      h.emitter.emit('user-prompt', { sid: 'sid-armed' });
      emit(h.emitter, { sid: 'sid-armed', state: 'idle' });
      expect(h.log).toHaveLength(1);
      // Wait past dedupe — second idle still suppressed (arm consumed).
      vi.advanceTimersByTime(10_000);
      emit(h.emitter, { sid: 'sid-armed', state: 'idle' });
      expect(h.log).toHaveLength(1);
      h.dispose();
    });

    it('multi-segment turn with a >5s gap fires only once (#631 reproduction)', () => {
      vi.useFakeTimers();
      const h = makeHarness();
      // User typed → watcher arms.
      h.emitter.emit('user-prompt', { sid: 'sid-multi' });
      // First segment finishes → idle fires (consumes arm).
      emit(h.emitter, { sid: 'sid-multi', state: 'idle' });
      expect(h.log).toHaveLength(1);
      // 6.5s gap (past DEDUPE_WINDOW_MS=5s).
      vi.advanceTimersByTime(6_500);
      // CLI continues without a new user prompt → tool_use → end_turn idle.
      // No `user-prompt` between, so arm is still false.
      emit(h.emitter, { sid: 'sid-multi', state: 'running' });
      emit(h.emitter, { sid: 'sid-multi', state: 'idle' });
      // Pre-fix: this would be 2. Post-fix: 1.
      expect(h.log).toHaveLength(1);
      h.dispose();
    });

    it('requires_action ALWAYS fires regardless of arm state', () => {
      const h = makeHarness();
      // Not armed → idle wouldn't fire, but RA must.
      emit(h.emitter, { sid: 'sid-ra', state: 'requires_action' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].state).toBe('requires_action');
      h.dispose();
    });

    it('arm is per-sid (arming sid A does not arm sid B)', () => {
      const h = makeHarness();
      h.emitter.emit('user-prompt', { sid: 'sid-A' });
      emit(h.emitter, { sid: 'sid-B', state: 'idle' });
      expect(h.log).toHaveLength(0);
      emit(h.emitter, { sid: 'sid-A', state: 'idle' });
      expect(h.log).toHaveLength(1);
      expect(h.log[0].sid).toBe('sid-A');
      h.dispose();
    });

    it('case #4: each requires_action + tool_result re-arm cycle fires once each, plus final idle', () => {
      vi.useFakeTimers();
      const h = makeHarness();
      h.emitter.emit('user-prompt', { sid: 'sid-perm' });
      // RA #1.
      emit(h.emitter, { sid: 'sid-perm', state: 'requires_action' });
      expect(h.log).toHaveLength(1);
      // User answers → watcher emits user-prompt (re-arm).
      vi.advanceTimersByTime(6_000);
      h.emitter.emit('user-prompt', { sid: 'sid-perm' });
      // RA #2.
      emit(h.emitter, { sid: 'sid-perm', state: 'requires_action' });
      expect(h.log).toHaveLength(2);
      // User answers again.
      vi.advanceTimersByTime(6_000);
      h.emitter.emit('user-prompt', { sid: 'sid-perm' });
      // Final idle.
      emit(h.emitter, { sid: 'sid-perm', state: 'idle' });
      expect(h.log).toHaveLength(3);
      h.dispose();
    });

    it('malformed user-prompt events are ignored', () => {
      const h = makeHarness();
      // @ts-expect-error — null payload
      h.emitter.emit('user-prompt', null);
      h.emitter.emit('user-prompt', { sid: '' });
      emit(h.emitter, { sid: 'sid-x', state: 'idle' });
      expect(h.log).toHaveLength(0);
      h.dispose();
    });

    it('dispose clears the armed map (re-install starts unarmed)', () => {
      const h = makeHarness();
      h.emitter.emit('user-prompt', { sid: 'sid-leak' });
      h.dispose();
      // Same emitter, fresh bridge — must NOT be armed.
      const log2: NotifyPayload[] = [];
      const dispose2 = installNotifyBridge({
        sessionWatcher: h.emitter,
        getMainWindow: () => null,
        isMutedFn: () => false,
        notifyImpl: { show: (p) => log2.push(p) },
      });
      emit(h.emitter, { sid: 'sid-leak', state: 'idle' });
      expect(log2).toHaveLength(0);
      dispose2();
    });
  });

  describe('name resolution in body', () => {
    // The bug we're fixing: pre-fix, the body always interpolated the short
    // sid prefix, so users saw "1a2b3c4d completed its task" instead of the
    // friendly name they renamed the session to.

    it('uses the friendly name from getNameFn when present', () => {
      const sid = '11112222-aaaa-bbbb-cccc-deadbeefcafe';
      const h = makeHarness({ names: { [sid]: 'my-feature' } });
      armAndEmitIdle(h.emitter, sid);
      expect(h.log).toHaveLength(1);
      // Body must contain the friendly name, NOT the sid prefix.
      expect(h.log[0].body).toContain('my-feature');
      expect(h.log[0].body).not.toContain('11112222');
      h.dispose();
    });

    it('falls back to short sid when name missing', () => {
      const sid = 'deadbeef-1111-2222-3333-444455556666';
      const h = makeHarness();
      armAndEmitIdle(h.emitter, sid);
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('deadbeef');
      h.dispose();
    });

    it('falls back to short sid when name is the "New session" placeholder', () => {
      const sid = 'cafebabe-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: 'New session' } });
      armAndEmitIdle(h.emitter, sid);
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('cafebabe');
      expect(h.log[0].body).not.toContain('New session');
      h.dispose();
    });

    it('falls back to short sid when name is the Chinese placeholder', () => {
      const sid = 'feedface-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: '新会话' } });
      armAndEmitIdle(h.emitter, sid);
      expect(h.log).toHaveLength(1);
      expect(h.log[0].body).toContain('feedface');
      h.dispose();
    });

    it('falls back to short sid when name is empty/whitespace', () => {
      const sid = '0badc0de-1111-2222-3333-444455556666';
      const h = makeHarness({ names: { [sid]: '   ' } });
      armAndEmitIdle(h.emitter, sid);
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
