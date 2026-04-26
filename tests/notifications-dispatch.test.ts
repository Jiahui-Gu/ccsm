// Tests for `src/notifications/dispatch.ts` after the W1 simplification.
//
// Behaviour locked in by the W1 spec:
//   - Single gate: only the global `enabled` toggle suppresses dispatch.
//   - No focus gate, no debounce, no per-event toggle, no per-session mute.
//   - Reason codes: 'no-api' (window.ccsm missing) | 'global-disabled'.
//   - `silent: !sound` is forwarded to the IPC payload so the OS toast
//     adapter can pick the right channel.
//
// Also exercises `migrateNotificationSettings` (W2 hydration) so the four
// possible legacy/partial input shapes all collapse to `{ enabled, sound }`.

import { describe, it, expect, beforeEach, vi } from 'vitest';

type NotifyPayload = {
  sessionId: string;
  title: string;
  body?: string;
  eventType?: string;
  silent?: boolean;
  extras?: Record<string, unknown>;
};

async function freshDispatch(): Promise<{
  dispatch: typeof import('../src/notifications/dispatch');
  store: typeof import('../src/stores/store').useStore;
  notifyCalls: NotifyPayload[];
}> {
  vi.resetModules();
  const notifyCalls: NotifyPayload[] = [];
  (globalThis as unknown as { window: { ccsm: unknown } }).window = {
    ccsm: {
      notify: async (payload: NotifyPayload) => {
        notifyCalls.push(payload);
        return true;
      }
    }
  };
  const dispatch = await import('../src/notifications/dispatch');
  const storeMod = await import('../src/stores/store');
  return { dispatch, store: storeMod.useStore, notifyCalls };
}

describe('dispatchNotification (single-gate)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fires when enabled and forwards eventType + silent=false (default sound on)', async () => {
    const h = await freshDispatch();
    const res = await h.dispatch.dispatchNotification({
      sessionId: 's1',
      eventType: 'permission',
      title: 'group / sess',
      body: 'Permission'
    });
    expect(res).toEqual({ dispatched: true });
    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0]).toMatchObject({
      sessionId: 's1',
      title: 'group / sess',
      body: 'Permission',
      eventType: 'permission',
      silent: false
    });
  });

  it('forwards silent=true when the sound setting is off', async () => {
    const h = await freshDispatch();
    h.store.getState().setNotificationSettings({ sound: false });
    await h.dispatch.dispatchNotification({
      sessionId: 's1',
      eventType: 'turn_done',
      title: 't',
      body: 'Turn done'
    });
    expect(h.notifyCalls[0].silent).toBe(true);
  });

  it('returns global-disabled when enabled=false, no IPC fired', async () => {
    const h = await freshDispatch();
    h.store.getState().setNotificationSettings({ enabled: false });
    const res = await h.dispatch.dispatchNotification({
      sessionId: 's1',
      eventType: 'permission',
      title: 't'
    });
    expect(res).toEqual({ dispatched: false, reason: 'global-disabled' });
    expect(h.notifyCalls).toEqual([]);
  });

  it('returns no-api when window.ccsm is missing (preload failed)', async () => {
    vi.resetModules();
    (globalThis as unknown as { window: unknown }).window = {};
    const dispatch = await import('../src/notifications/dispatch');
    const res = await dispatch.dispatchNotification({
      sessionId: 's1',
      eventType: 'permission',
      title: 't'
    });
    expect(res).toEqual({ dispatched: false, reason: 'no-api' });
  });

  it('fires regardless of focus / active session — no focus gate', async () => {
    const h = await freshDispatch();
    // Force document.hasFocus → true; pre-W1 dispatch suppressed the active
    // session in this case. Post-W1 it must still fire because the focus
    // gate has been removed entirely.
    if ((globalThis as unknown as { document?: Document }).document) {
      (globalThis as unknown as { document: Document }).document.hasFocus = () => true;
    }
    h.store.getState().createSession('~/x');
    const sid = h.store.getState().activeId;
    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'group / sess'
    });
    expect(res).toEqual({ dispatched: true });
    expect(h.notifyCalls).toHaveLength(1);
  });

  it('fires repeatedly on the same (session, event) — no debounce', async () => {
    const h = await freshDispatch();
    for (let i = 0; i < 3; i++) {
      const res = await h.dispatch.dispatchNotification({
        sessionId: 's1',
        eventType: 'permission',
        title: `t-${i}`
      });
      expect(res.dispatched).toBe(true);
    }
    expect(h.notifyCalls).toHaveLength(3);
  });

  it('forwards extras (toastId / sessionName / groupName / eventType)', async () => {
    const h = await freshDispatch();
    await h.dispatch.dispatchNotification({
      sessionId: 's1',
      eventType: 'turn_done',
      title: 'g / s',
      body: 'Turn done',
      extras: {
        toastId: 'done-1',
        sessionName: 's',
        groupName: 'g',
        eventType: 'turn_done'
      }
    });
    expect(h.notifyCalls[0].extras).toEqual({
      toastId: 'done-1',
      sessionName: 's',
      groupName: 'g',
      eventType: 'turn_done'
    });
  });
});

describe('handleNotificationFocus', () => {
  it('selects the session and is a no-op for unknown ids', async () => {
    const h = await freshDispatch();
    // handleNotificationFocus calls window.requestAnimationFrame after the
    // store update; stub it so jsdom doesn't blow up. The rAF callback only
    // touches the DOM scroll position which we don't assert here.
    (window as unknown as { requestAnimationFrame: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
      (cb) => {
        cb(0);
        return 0;
      };
    h.store.getState().createSession('~/a');
    const a = h.store.getState().activeId;
    h.store.getState().createSession('~/b');
    const b = h.store.getState().activeId;
    h.store.getState().selectSession(a);

    h.dispatch.handleNotificationFocus(b);
    expect(h.store.getState().activeId).toBe(b);

    // Unknown id — no throw, activeId unchanged.
    h.dispatch.handleNotificationFocus('does-not-exist');
    expect(h.store.getState().activeId).toBe(b);
  });
});

describe('migrateNotificationSettings (W2 hydration)', () => {
  // Covers all four legacy / partial input patterns the migrate fn must
  // collapse into the post-W2 `{ enabled, sound }` shape.
  it('full pre-simplification shape: keeps enabled + sound, drops per-event keys', async () => {
    const { migrateNotificationSettings } = await import('../src/stores/store');
    const out = migrateNotificationSettings({
      enabled: false,
      permission: false,
      question: false,
      turnDone: false,
      sound: false
    });
    expect(out).toEqual({ enabled: false, sound: false });
    expect(Object.keys(out).sort()).toEqual(['enabled', 'sound']);
  });

  it('partial shape: missing fields default to true', async () => {
    const { migrateNotificationSettings } = await import('../src/stores/store');
    expect(migrateNotificationSettings({ enabled: false })).toEqual({
      enabled: false,
      sound: true
    });
  });

  it('empty object → both defaults (true)', async () => {
    const { migrateNotificationSettings } = await import('../src/stores/store');
    expect(migrateNotificationSettings({})).toEqual({ enabled: true, sound: true });
  });

  it('null / non-object → full default object', async () => {
    const { migrateNotificationSettings, DEFAULT_NOTIFICATION_SETTINGS } = await import(
      '../src/stores/store'
    );
    expect(migrateNotificationSettings(null)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(migrateNotificationSettings(undefined)).toEqual(DEFAULT_NOTIFICATION_SETTINGS);
    expect(migrateNotificationSettings('garbage' as unknown)).toEqual(
      DEFAULT_NOTIFICATION_SETTINGS
    );
  });

  it('non-boolean enabled / sound coerce to default true', async () => {
    const { migrateNotificationSettings } = await import('../src/stores/store');
    expect(
      migrateNotificationSettings({ enabled: 0, sound: 'yes' } as unknown as Record<string, unknown>)
    ).toEqual({ enabled: true, sound: true });
  });
});
