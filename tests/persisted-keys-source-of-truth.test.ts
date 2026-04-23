// Locks the PERSISTED_KEYS contract introduced as the single source of truth
// for the persist subscriber. Both the early-bail comparator and the snapshot
// builder in `hydrateStore` iterate `PERSISTED_KEYS`, so adding a new key
// only requires editing that one array.
//
// This test guards two things:
//  1. Every key listed in PERSISTED_KEYS lands in the serialized snapshot
//     (the write path includes it).
//  2. Mutating any field listed in PERSISTED_KEYS triggers a fresh debounced
//     write (the comparator does NOT early-bail on it).
//
// If a future change adds a key to PERSISTED_KEYS but accidentally skips it
// in the comparator or snapshot loop, both halves of this test catch it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PERSISTED_KEYS } from '../src/stores/persist';

// `hydrateStore` is the only path that installs the persist subscriber, and
// it does so as a module-level side effect once per process. We need a fresh
// store + fresh subscriber for each test, so we re-import via `vi.resetModules`
// between scenarios.
async function freshStore(saveState: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  (globalThis as unknown as { window?: unknown }).window = {
    agentory: {
      saveState,
      loadState: vi.fn().mockResolvedValue(null),
      saveMessages: vi.fn().mockResolvedValue(undefined),
      loadMessages: vi.fn().mockResolvedValue([]),
      pathsExist: vi.fn().mockResolvedValue({}),
      recentCwds: vi.fn().mockResolvedValue([]),
      topModel: vi.fn().mockResolvedValue(null),
      models: { list: vi.fn().mockResolvedValue([]) },
      connection: { read: vi.fn().mockResolvedValue(null) },
      cli: { retryDetect: vi.fn().mockResolvedValue({ found: true, path: '/x', version: '2.1.0' }) }
    }
  };
  const storeMod = await import('../src/stores/store');
  const persistMod = await import('../src/stores/persist');
  await storeMod.hydrateStore();
  return { storeMod, persistMod };
}

describe('persist: PERSISTED_KEYS is the single source of truth', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  // Drift guard: any time a key is added/removed/reordered in PERSISTED_KEYS
  // this snapshot flips, which surfaces the change as a visible diff in the
  // PR touching PERSISTED_KEYS. Without this the only drift signal was a
  // behavioral test failing with "comparator early-bailed on persisted key
  // X" — correct but less obvious at review time. Update the snapshot in
  // the same commit that changes PERSISTED_KEYS; reviewers should verify
  // the new key is genuinely meant to be persisted.
  it('PERSISTED_KEYS shape matches snapshot (update together with source)', () => {
    expect(PERSISTED_KEYS).toMatchInlineSnapshot(`
      [
        "sessions",
        "groups",
        "activeId",
        "model",
        "permission",
        "sidebarCollapsed",
        "sidebarWidth",
        "theme",
        "fontSize",
        "fontSizePx",
        "density",
        "recentProjects",
        "tutorialSeen",
        "notificationSettings",
      ]
    `);
    // Structural invariants that any future key must satisfy. Catches a
    // mechanically-broken entry even if the snapshot is updated carelessly.
    expect(PERSISTED_KEYS.length).toBeGreaterThan(0);
    for (const k of PERSISTED_KEYS) {
      expect(typeof k, `PERSISTED_KEYS entry must be a string, got ${String(k)}`).toBe('string');
      expect(k.length, 'PERSISTED_KEYS entry must be non-empty').toBeGreaterThan(0);
    }
    expect(new Set(PERSISTED_KEYS).size, 'PERSISTED_KEYS must be duplicate-free').toBe(
      PERSISTED_KEYS.length
    );
  });

  it('every key in PERSISTED_KEYS lands in the serialized snapshot', async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    const { storeMod } = await freshStore(saveState);
    // Force a write by replacing the whole sessions array (a persisted field).
    storeMod.useStore.setState({ sessions: [] });
    storeMod.useStore.setState({
      sessions: [
        {
          id: 's-test',
          name: 't',
          state: 'idle',
          cwd: '~',
          model: '',
          groupId: 'g-default',
          agentType: 'claude-code'
        }
      ]
    });
    vi.advanceTimersByTime(500);
    expect(saveState).toHaveBeenCalled();
    const lastCall = saveState.mock.calls[saveState.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(lastCall[1]);
    for (const k of PERSISTED_KEYS) {
      expect(parsed, `missing persisted key ${k}`).toHaveProperty(k);
    }
    expect(parsed).toHaveProperty('version', 1);
  });

  it('mutating any PERSISTED_KEYS field triggers a fresh write (comparator covers all keys)', async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    const { storeMod } = await freshStore(saveState);
    // Warm up the comparator so prevSnap !== null. Without this the first
    // setState below would unconditionally write (bypassing the comparator)
    // and one key would be tested trivially.
    storeMod.useStore.setState({ activeId: 'warmup' });
    vi.advanceTimersByTime(500);
    saveState.mockClear();

    // For each persisted key, replace its value with a fresh reference and
    // assert that the subscriber DID NOT early-bail (i.e. saveState fires).
    const fresh: Record<string, unknown> = {
      sessions: [],
      groups: [{ id: 'g-x', name: 'x', collapsed: false, kind: 'normal' }],
      activeId: 'a',
      model: 'm',
      permission: 'plan',
      sidebarCollapsed: true,
      sidebarWidth: 321,
      theme: 'dark',
      fontSize: 'lg',
      fontSizePx: 16,
      density: 'compact',
      recentProjects: [{ id: 'p1', name: 'n', path: '/x' }],
      tutorialSeen: true,
      notificationSettings: {
        enabled: false,
        permission: false,
        question: false,
        turnDone: false,
        sound: false
      }
    };

    for (const k of PERSISTED_KEYS) {
      saveState.mockClear();
      storeMod.useStore.setState({ [k]: fresh[k] } as Partial<typeof fresh>);
      vi.advanceTimersByTime(500);
      expect(
        saveState,
        `comparator early-bailed on persisted key "${k}" — comparator and PERSISTED_KEYS are out of sync`
      ).toHaveBeenCalled();
    }
  });

  it('mutating a non-persisted field does NOT trigger a write (early-bail still works)', async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    const { storeMod } = await freshStore(saveState);
    // Warm up the comparator: the very first subscriber call has
    // prevSnap === null and unconditionally writes. Trigger one persisted
    // mutation so prevSnap is populated, then start asserting non-writes.
    storeMod.useStore.setState({ activeId: 'warmup' });
    vi.advanceTimersByTime(500);
    saveState.mockClear();

    // focusInputNonce is intentionally NOT in PERSISTED_KEYS — bumping it on
    // every session click must not write to disk.
    storeMod.useStore.setState({ focusInputNonce: 42 });
    vi.advanceTimersByTime(500);
    expect(saveState).not.toHaveBeenCalled();

    storeMod.useStore.setState({ runningSessions: { foo: true } });
    vi.advanceTimersByTime(500);
    expect(saveState).not.toHaveBeenCalled();
  });
});
