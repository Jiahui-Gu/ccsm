import { describe, it, expect, beforeEach, vi } from 'vitest';

type NotifyPayload = {
  sessionId: string;
  title: string;
  body?: string;
  eventType?: string;
  silent?: boolean;
};

// Each test rebuilds the module graph so module-level dispatch state (the
// per-(session,event) debounce map) starts clean. We also stub out
// window.agentory minimally — dispatch only needs `notify`.
async function freshDispatch(): Promise<{
  dispatch: typeof import('../src/notifications/dispatch');
  store: typeof import('../src/stores/store').useStore;
  notifyCalls: NotifyPayload[];
}> {
  vi.resetModules();
  const notifyCalls: NotifyPayload[] = [];
  (globalThis as unknown as { window: { agentory: unknown } }).window = {
    agentory: {
      notify: async (payload: NotifyPayload) => {
        notifyCalls.push(payload);
        return true;
      }
    }
  };
  const dispatch = await import('../src/notifications/dispatch');
  const storeMod = await import('../src/stores/store');
  dispatch.resetDispatchState();
  return { dispatch, store: storeMod.useStore, notifyCalls };
}

function setupSession(
  store: typeof import('../src/stores/store').useStore,
  opts: { active?: boolean } = {}
): string {
  store.getState().createSession('~/x');
  const sid = store.getState().activeId;
  if (opts.active === false) {
    // createSession auto-selects; deselect by creating another and selecting it.
    store.getState().createSession('~/y');
    const other = store.getState().activeId;
    store.getState().selectSession(other);
  }
  return sid;
}

describe('dispatchNotification', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('fires when window unfocused and all settings default (enabled)', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => false });
    const sid = setupSession(h.store);

    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'Needs input'
    });

    expect(res.dispatched).toBe(true);
    expect(h.notifyCalls).toHaveLength(1);
    expect(h.notifyCalls[0].eventType).toBe('permission');
    expect(h.notifyCalls[0].silent).toBe(false); // sound default on
  });

  it('suppresses when window focused AND session is active', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => true });
    const sid = setupSession(h.store);

    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'x'
    });

    expect(res).toEqual({ dispatched: false, reason: 'focused-active' });
    expect(h.notifyCalls).toEqual([]);
  });

  it('fires when window focused but the event is for a different session', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => true });
    const bg = setupSession(h.store, { active: false });

    const res = await h.dispatch.dispatchNotification({
      sessionId: bg,
      eventType: 'permission',
      title: 'bg session needs you'
    });

    expect(res.dispatched).toBe(true);
    expect(h.notifyCalls).toHaveLength(1);
  });

  it('debounces a second notification within 30s for the same (session,event)', async () => {
    const h = await freshDispatch();
    let fakeNow = 1_000_000;
    h.dispatch.setDispatchEnv({ hasFocus: () => false, now: () => fakeNow });
    const sid = setupSession(h.store);

    const first = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'first'
    });
    expect(first.dispatched).toBe(true);

    fakeNow += 10_000;
    const second = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'second'
    });
    expect(second).toEqual({ dispatched: false, reason: 'debounced' });

    // Past the 30s window, it fires again.
    fakeNow += 25_000;
    const third = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'third'
    });
    expect(third.dispatched).toBe(true);
    expect(h.notifyCalls).toHaveLength(2);
  });

  it('debounce is scoped per event type — different event types do not share a quota', async () => {
    const h = await freshDispatch();
    const fakeNow = 1_000_000;
    h.dispatch.setDispatchEnv({ hasFocus: () => false, now: () => fakeNow });
    const sid = setupSession(h.store);

    const a = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'a'
    });
    const b = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'question',
      title: 'b'
    });
    expect(a.dispatched).toBe(true);
    expect(b.dispatched).toBe(true);
    expect(h.notifyCalls).toHaveLength(2);
  });

  it('respects the global enabled toggle', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => false });
    const sid = setupSession(h.store);
    h.store.getState().setNotificationSettings({ enabled: false });

    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'x'
    });
    expect(res).toEqual({ dispatched: false, reason: 'global-disabled' });
  });

  it('respects the per-event-type toggle', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => false });
    const sid = setupSession(h.store);
    h.store.getState().setNotificationSettings({ turnDone: false });

    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'turn_done',
      title: 'done'
    });
    expect(res).toEqual({ dispatched: false, reason: 'event-disabled' });
  });

  it('respects per-session mute', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => false });
    const sid = setupSession(h.store);
    h.store.getState().setSessionNotificationsMuted(sid, true);

    const res = await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'x'
    });
    expect(res).toEqual({ dispatched: false, reason: 'session-muted' });
  });

  it('passes silent=true when sound setting is off', async () => {
    const h = await freshDispatch();
    h.dispatch.setDispatchEnv({ hasFocus: () => false });
    const sid = setupSession(h.store);
    h.store.getState().setNotificationSettings({ sound: false });

    await h.dispatch.dispatchNotification({
      sessionId: sid,
      eventType: 'permission',
      title: 'x'
    });
    expect(h.notifyCalls[0].silent).toBe(true);
  });
});

describe('notification settings persistence', () => {
  it('round-trips notificationSettings through the persisted snapshot shape', async () => {
    vi.resetModules();
    (globalThis as unknown as { window: unknown }).window = { agentory: undefined };
    const storeMod = await import('../src/stores/store');
    const store = storeMod.useStore;

    store.getState().setNotificationSettings({
      enabled: false,
      permission: false,
      turnDone: false,
      sound: false
    });

    // Simulate the persist snapshot builder (matches store.ts subscribe).
    const s = store.getState();
    const snapshot = {
      version: 1 as const,
      sessions: s.sessions,
      groups: s.groups,
      activeId: s.activeId,
      model: s.model,
      permission: s.permission,
      sidebarCollapsed: s.sidebarCollapsed,
      theme: s.theme,
      fontSize: s.fontSize,
      recentProjects: s.recentProjects,
      tutorialSeen: s.tutorialSeen,
      watchdog: s.watchdog,
      notificationSettings: s.notificationSettings
    };
    const json = JSON.parse(JSON.stringify(snapshot));
    expect(json.notificationSettings).toEqual({
      enabled: false,
      permission: false,
      question: true,
      turnDone: false,
      sound: false
    });
  });
});
