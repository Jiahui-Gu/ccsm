// Tests for `hydrateStore()` in src/stores/store.ts.
//
// The module wires up a one-shot boot sequence (drafts + main snapshot +
// scrollback + deferred IPCs + persist subscriber). It owns a
// module-singleton `hydrated` flag, so each test path re-imports the module
// via `vi.resetModules()` to get a clean run. Where `hydrateStore` touches
// `loadPersisted` / `hydrateDrafts` / `schedulePersist`, we mock those
// modules so we can drive the persisted shape from the test (rather than
// stubbing real IDB / IPC plumbing).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { PersistedState } from '../../src/stores/persist';

type CcsmShape = {
  loadState?: ReturnType<typeof vi.fn>;
  saveState?: ReturnType<typeof vi.fn>;
  userHome?: ReturnType<typeof vi.fn>;
  defaultModel?: ReturnType<typeof vi.fn>;
  pathsExist?: ReturnType<typeof vi.fn>;
};

function installCcsm(overrides: CcsmShape = {}): CcsmShape {
  const ccsm: CcsmShape = {
    loadState: overrides.loadState ?? vi.fn(async () => null),
    saveState: overrides.saveState ?? vi.fn(async () => undefined),
    userHome: overrides.userHome ?? vi.fn(async () => '/home/tester'),
    defaultModel: overrides.defaultModel ?? vi.fn(async () => 'claude-3-5-sonnet'),
    pathsExist: overrides.pathsExist ?? vi.fn(async (paths: string[]) =>
      Object.fromEntries(paths.map((p) => [p, true]))
    ),
  };
  (window as unknown as { ccsm: CcsmShape }).ccsm = ccsm;
  return ccsm;
}

function clearWindowExtras() {
  delete (window as unknown as { ccsm?: unknown }).ccsm;
  delete (window as unknown as { __ccsmHydrationTrace?: unknown }).__ccsmHydrationTrace;
  delete (window as unknown as { __ccsmDrafts?: unknown }).__ccsmDrafts;
}

// Re-import store + persist + drafts after a resetModules so the
// module-level singleton state (`hydrated`, `cache`, subscribers) starts
// clean. Returns the freshly-loaded module bundle.
async function freshStore() {
  vi.resetModules();
  const persist = await import('../../src/stores/persist');
  const drafts = await import('../../src/stores/drafts');
  const store = await import('../../src/stores/store');
  return { persist, drafts, store };
}

beforeEach(() => {
  clearWindowExtras();
});

afterEach(() => {
  vi.restoreAllMocks();
  clearWindowExtras();
});

describe('hydrateStore: persisted snapshot load', () => {
  it('starts hydrated=false and flips to true after hydrateStore resolves', async () => {
    installCcsm();
    const { store } = await freshStore();
    expect(store.useStore.getState().hydrated).toBe(false);
    await store.hydrateStore();
    expect(store.useStore.getState().hydrated).toBe(true);
  });

  it('applies persisted sessions/groups/theme/font from the main snapshot', async () => {
    const snap: PersistedState = {
      version: 1,
      sessions: [
        // Just enough to satisfy `sessions.some(s => s.id === activeId)`.
        // The slice doesn't reach into Session internals during hydrate.
        { id: 's-1', name: 'one', cwd: '/x', model: 'claude-3-5-sonnet' } as unknown as PersistedState['sessions'][number],
        { id: 's-2', name: 'two', cwd: '/y', model: 'claude-3-5-sonnet' } as unknown as PersistedState['sessions'][number],
      ],
      groups: [],
      activeId: 's-2',
      sidebarWidth: 320,
      theme: 'dark',
      fontSize: 'lg',
      fontSizePx: 16,
    };
    installCcsm({
      loadState: vi.fn(async (key: string) => {
        if (key === 'main') return JSON.stringify(snap);
        return null;
      }),
    });
    const { store } = await freshStore();
    await store.hydrateStore();
    const s = store.useStore.getState();
    expect(s.sessions.map((x) => x.id)).toEqual(['s-1', 's-2']);
    expect(s.activeId).toBe('s-2');
    expect(s.theme).toBe('dark');
    expect(s.fontSizePx).toBe(16);
    expect(s.sidebarWidth).toBe(320);
    expect(s.hydrated).toBe(true);
  });

  it('falls back to first session id when persisted activeId no longer exists', async () => {
    const snap: PersistedState = {
      version: 1,
      sessions: [
        { id: 's-1', name: 'one', cwd: '/x', model: 'm' } as unknown as PersistedState['sessions'][number],
      ],
      groups: [],
      // activeId points to a session that's been deleted between runs.
      activeId: 's-deleted',
    };
    installCcsm({
      loadState: vi.fn(async (key: string) =>
        key === 'main' ? JSON.stringify(snap) : null
      ),
    });
    const { store } = await freshStore();
    await store.hydrateStore();
    expect(store.useStore.getState().activeId).toBe('s-1');
  });

  it('returns gracefully when no persisted snapshot exists (fresh install)', async () => {
    installCcsm();
    const { store } = await freshStore();
    await store.hydrateStore();
    const s = store.useStore.getState();
    expect(s.hydrated).toBe(true);
    expect(s.sessions).toEqual([]);
    // Defaults from appearanceSlice survive untouched.
    expect(s.theme).toBe('system');
  });

  it('is idempotent — calling twice does not re-apply persisted state', async () => {
    const loadState = vi.fn(async () => null);
    installCcsm({ loadState });
    const { store } = await freshStore();
    await store.hydrateStore();
    const callsAfterFirst = loadState.mock.calls.length;
    await store.hydrateStore();
    expect(loadState.mock.calls.length).toBe(callsAfterFirst);
  });
});

describe('hydrateStore: scrollback key', () => {
  it('applies a persisted scrollback line cap when present', async () => {
    installCcsm({
      loadState: vi.fn(async (key: string) => {
        if (key === 'scrollbackLines') return '4096';
        return null;
      }),
    });
    const { store } = await freshStore();
    await store.hydrateStore();
    expect(store.useStore.getState().scrollbackLines).toBe(4096);
  });

  it('keeps the slice default when scrollback load throws', async () => {
    installCcsm({
      loadState: vi.fn(async (key: string) => {
        if (key === 'scrollbackLines') throw new Error('idb gone');
        return null;
      }),
    });
    const { store } = await freshStore();
    await expect(store.hydrateStore()).resolves.toBeUndefined();
    // Default from createAppearanceSlice — never overwritten on load failure.
    expect(store.useStore.getState().scrollbackLines).toBe(1500);
  });
});

describe('hydrateStore: drafts integration', () => {
  it('awaits hydrateDrafts before flipping hydrated', async () => {
    // Resolve order: drafts load (loadState('drafts')) must complete before
    // hydrated flips. We assert ordering by tracking the moment each fires.
    const order: string[] = [];
    installCcsm({
      loadState: vi.fn(async (key: string) => {
        order.push(`load:${key}`);
        return null;
      }),
    });
    const { store } = await freshStore();
    await store.hydrateStore();
    order.push('done');
    // loadState('drafts') is called from hydrateDrafts() which runs first,
    // then loadState('main') from loadPersisted(), then loadState('scrollbackLines').
    expect(order[0]).toBe('load:drafts');
    expect(order).toContain('load:main');
    expect(order).toContain('load:scrollbackLines');
    expect(order[order.length - 1]).toBe('done');
  });

  it('hydrate continues when a corrupt drafts blob is present', async () => {
    installCcsm({
      loadState: vi.fn(async (key: string) => {
        if (key === 'drafts') return '{not json';
        return null;
      }),
    });
    const { store } = await freshStore();
    await expect(store.hydrateStore()).resolves.toBeUndefined();
    expect(store.useStore.getState().hydrated).toBe(true);
  });
});

describe('hydrateStore: persist subscriber wiring', () => {
  it('writes a curated snapshot through saveState when persisted state changes', async () => {
    const saveState = vi.fn(async () => undefined);
    installCcsm({ saveState });
    vi.useFakeTimers();
    try {
      const { store } = await freshStore();
      await store.hydrateStore();
      // Trigger a mutation on a persisted field. theme is in PERSISTED_KEYS.
      store.useStore.setState({ theme: 'dark' });
      // schedulePersist's 250ms debounce + microtask drain.
      await vi.advanceTimersByTimeAsync(300);
      expect(saveState).toHaveBeenCalled();
      const calls = saveState.mock.calls.filter((c) => c[0] === 'main');
      expect(calls.length).toBeGreaterThan(0);
      const lastBlob = JSON.parse(calls[calls.length - 1][1] as string);
      expect(lastBlob).toHaveProperty('version', 1);
      expect(lastBlob.theme).toBe('dark');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does NOT write when only non-persisted state mutates (early bail)', async () => {
    const saveState = vi.fn(async () => undefined);
    installCcsm({ saveState });
    vi.useFakeTimers();
    try {
      const { store } = await freshStore();
      await store.hydrateStore();
      // The subscriber unconditionally writes the FIRST snapshot (prevSnap is
      // null on the first mutation), so drain that baseline write before
      // asserting the early-bail behaviour on subsequent mutations.
      store.useStore.setState({ theme: 'light' });
      await vi.advanceTimersByTimeAsync(300);
      saveState.mockClear();
      // `flashStates` is in State but NOT in PERSISTED_KEYS — the
      // reference-equality comparator over PERSISTED_KEYS should early-bail.
      store.useStore.setState({ flashStates: { 's-1': true } });
      await vi.advanceTimersByTimeAsync(300);
      expect(saveState).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('hydrateStore: deferred boot IPCs', () => {
  it('seeds userHome + claudeSettingsDefaultModel from main after first paint', async () => {
    const userHome = vi.fn(async () => '/home/me');
    const defaultModel = vi.fn(async () => 'claude-haiku');
    installCcsm({ userHome, defaultModel });
    const { store } = await freshStore();
    await store.hydrateStore();
    // The deferred IPC is fire-and-forget; drain pending promises.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    expect(userHome).toHaveBeenCalled();
    expect(defaultModel).toHaveBeenCalled();
    const s = store.useStore.getState();
    expect(s.userHome).toBe('/home/me');
    expect(s.claudeSettingsDefaultModel).toBe('claude-haiku');
  });

  it('tags sessions whose cwd no longer exists via pathsExist', async () => {
    const snap: PersistedState = {
      version: 1,
      sessions: [
        { id: 's-1', name: 'one', cwd: '/exists', model: 'm' } as unknown as PersistedState['sessions'][number],
        { id: 's-2', name: 'two', cwd: '/gone', model: 'm' } as unknown as PersistedState['sessions'][number],
      ],
      groups: [],
      activeId: 's-1',
    };
    installCcsm({
      loadState: vi.fn(async (k: string) => (k === 'main' ? JSON.stringify(snap) : null)),
      pathsExist: vi.fn(async () => ({ '/exists': true, '/gone': false })),
    });
    const { store } = await freshStore();
    await store.hydrateStore();
    // Drain deferred microtasks.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
    const sessions = store.useStore.getState().sessions;
    const tagged = sessions.find((s) => s.id === 's-2') as { cwdMissing?: boolean };
    const healthy = sessions.find((s) => s.id === 's-1') as { cwdMissing?: boolean };
    expect(tagged.cwdMissing).toBe(true);
    expect(healthy.cwdMissing).toBeUndefined();
  });

  it('swallows pathsExist errors without blowing up hydrate', async () => {
    const snap: PersistedState = {
      version: 1,
      sessions: [
        { id: 's-1', name: 'one', cwd: '/x', model: 'm' } as unknown as PersistedState['sessions'][number],
      ],
      groups: [],
      activeId: 's-1',
    };
    installCcsm({
      loadState: vi.fn(async (k: string) => (k === 'main' ? JSON.stringify(snap) : null)),
      pathsExist: vi.fn(async () => {
        throw new Error('ipc dropped');
      }),
    });
    const { store } = await freshStore();
    await expect(store.hydrateStore()).resolves.toBeUndefined();
    await new Promise((r) => setTimeout(r, 0));
    // Sessions remain untouched — no cwdMissing tag.
    const session = store.useStore.getState().sessions[0] as { cwdMissing?: boolean };
    expect(session.cwdMissing).toBeUndefined();
  });
});

describe('hydrateStore: trace bookkeeping', () => {
  it('writes hydrateStartedAt / hydrateDoneAt onto window.__ccsmHydrationTrace', async () => {
    installCcsm();
    const { store } = await freshStore();
    await store.hydrateStore();
    const trace = (window as unknown as {
      __ccsmHydrationTrace?: { hydrateStartedAt?: number; hydrateDoneAt?: number };
    }).__ccsmHydrationTrace;
    expect(trace).toBeTruthy();
    expect(typeof trace?.hydrateStartedAt).toBe('number');
    expect(typeof trace?.hydrateDoneAt).toBe('number');
    expect((trace!.hydrateDoneAt as number)).toBeGreaterThanOrEqual(
      trace!.hydrateStartedAt as number
    );
  });
});
