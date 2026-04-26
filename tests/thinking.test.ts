import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  coerceThinkingLevel,
  getMaxThinkingTokensForModel,
  THINKING_LEVELS,
} from '../src/agent/thinking';

describe('thinking: getMaxThinkingTokensForModel', () => {
  // Token caps mirror the upstream CLI keyword detector. If a future SDK
  // bump moves them, regrep `max_thinking_tokens` in the bundled
  // extension and update the literals together with the implementation.
  it('returns 0 when level is off (regardless of model)', () => {
    expect(getMaxThinkingTokensForModel('claude-sonnet-4-5', 'off')).toBe(0);
    expect(getMaxThinkingTokensForModel('claude-opus-4-7', 'off')).toBe(0);
    expect(getMaxThinkingTokensForModel(undefined, 'off')).toBe(0);
  });

  it('maps each tier to the upstream literal', () => {
    expect(getMaxThinkingTokensForModel(undefined, 'think')).toBe(4000);
    expect(getMaxThinkingTokensForModel(undefined, 'think_hard')).toBe(10000);
    expect(getMaxThinkingTokensForModel(undefined, 'think_harder')).toBe(31999);
    // ultrathink shares the cap with think_harder upstream today.
    expect(getMaxThinkingTokensForModel(undefined, 'ultrathink')).toBe(31999);
  });

  it('exposes all five tiers in display order', () => {
    expect([...THINKING_LEVELS]).toEqual([
      'off',
      'think',
      'think_hard',
      'think_harder',
      'ultrathink',
    ]);
  });
});

describe('thinking: coerceThinkingLevel', () => {
  it('round-trips every current tier', () => {
    for (const level of THINKING_LEVELS) {
      expect(coerceThinkingLevel(level)).toBe(level);
    }
  });

  it('migrates the legacy `default_on` to `think_harder` (same cap)', () => {
    // Pre-dropdown the toggle persisted `'default_on'` for the 31999-cap
    // state. Migrate to the equivalent tier so users don't lose their
    // setting across the upgrade.
    expect(coerceThinkingLevel('default_on')).toBe('think_harder');
  });

  it('returns null for malformed values', () => {
    expect(coerceThinkingLevel('whatever')).toBeNull();
    expect(coerceThinkingLevel(null)).toBeNull();
    expect(coerceThinkingLevel(undefined)).toBeNull();
    expect(coerceThinkingLevel(42)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Store-action coverage. Focuses on the IPC fan-out + per-session vs global
// state separation. The store's persisted-keys + hydration are covered by
// `persisted-keys-source-of-truth.test.ts`; here we only assert behaviour
// unique to the thinking actions.
// ─────────────────────────────────────────────────────────────────────────

async function freshStore(api: Record<string, unknown>) {
  vi.resetModules();
  (globalThis as unknown as { window?: unknown }).window = {
    ccsm: {
      saveState: vi.fn().mockResolvedValue(undefined),
      loadState: vi.fn().mockResolvedValue(null),
      loadHistory: vi.fn().mockResolvedValue({ ok: true, frames: [] }),
      pathsExist: vi.fn().mockResolvedValue({}),
      recentCwds: vi.fn().mockResolvedValue([]),
      topModel: vi.fn().mockResolvedValue(null),
      models: { list: vi.fn().mockResolvedValue([]) },
      connection: { read: vi.fn().mockResolvedValue(null) },
      ...api,
    },
  };
  const storeMod = await import('../src/stores/store');
  await storeMod.hydrateStore();
  return storeMod;
}

describe('store: thinking-level actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('setThinkingLevel updates per-session state', async () => {
    const agentSetMaxThinkingTokens = vi.fn().mockResolvedValue({ ok: true });
    const { useStore } = await freshStore({ agentSetMaxThinkingTokens });
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setThinkingLevel(sid, 'think_hard');
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('think_hard');
    // No IPC fan-out yet — session is not started.
    expect(agentSetMaxThinkingTokens).not.toHaveBeenCalled();
  });

  it('setThinkingLevel pushes the resolved cap when started, for every tier', async () => {
    const agentSetMaxThinkingTokens = vi.fn().mockResolvedValue({ ok: true });
    const { useStore } = await freshStore({ agentSetMaxThinkingTokens });
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().markStarted(sid);

    const expected: Array<[string, number]> = [
      ['off', 0],
      ['think', 4000],
      ['think_hard', 10000],
      ['think_harder', 31999],
      ['ultrathink', 31999],
    ];
    for (const [level, cap] of expected) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      useStore.getState().setThinkingLevel(sid, level as any);
      expect(agentSetMaxThinkingTokens).toHaveBeenLastCalledWith(sid, cap);
    }
  });

  it('setGlobalThinkingDefault updates global without touching per-session overrides', async () => {
    const { useStore } = await freshStore({});
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setThinkingLevel(sid, 'ultrathink');
    useStore.getState().setGlobalThinkingDefault('think');
    expect(useStore.getState().globalThinkingDefault).toBe('think');
    // Per-session override survives a global change.
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('ultrathink');
    useStore.getState().setGlobalThinkingDefault('off');
    expect(useStore.getState().globalThinkingDefault).toBe('off');
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('ultrathink');
  });

  it('persists global default + per-session overrides', async () => {
    const saveState = vi.fn().mockResolvedValue(undefined);
    vi.resetModules();
    (globalThis as unknown as { window?: unknown }).window = {
      ccsm: {
        saveState,
        loadState: vi.fn().mockResolvedValue(null),
        loadHistory: vi.fn().mockResolvedValue({ ok: true, frames: [] }),
        pathsExist: vi.fn().mockResolvedValue({}),
        recentCwds: vi.fn().mockResolvedValue([]),
        topModel: vi.fn().mockResolvedValue(null),
        models: { list: vi.fn().mockResolvedValue([]) },
        connection: { read: vi.fn().mockResolvedValue(null) },
      },
    };
    const { useStore, hydrateStore } = await import('../src/stores/store');
    await hydrateStore();
    useStore.getState().setGlobalThinkingDefault('think_harder');
    useStore.getState().setThinkingLevel('s-1', 'think');
    vi.advanceTimersByTime(500);
    expect(saveState).toHaveBeenCalled();
    const last = saveState.mock.calls[saveState.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(last[1]);
    expect(parsed.globalThinkingDefault).toBe('think_harder');
    expect(parsed.thinkingLevelBySession).toEqual({ 's-1': 'think' });
  });

  it('hydrates legacy `default_on` persisted values to `think_harder`', async () => {
    // Earlier ccsm builds persisted `'default_on'` for the 31999-cap
    // state. Hydration must transparently migrate so a returning user
    // sees their previous "thinking on" sessions land on the equivalent
    // `think_harder` tier.
    vi.resetModules();
    (globalThis as unknown as { window?: unknown }).window = {
      ccsm: {
        saveState: vi.fn().mockResolvedValue(undefined),
        loadState: vi.fn().mockResolvedValue(
          JSON.stringify({
            version: 1,
            sessions: [],
            groups: [],
            activeId: '',
            model: '',
            permission: 'default',
            globalThinkingDefault: 'default_on',
            thinkingLevelBySession: { 's-old': 'default_on' },
          }),
        ),
        loadHistory: vi.fn().mockResolvedValue({ ok: true, frames: [] }),
        pathsExist: vi.fn().mockResolvedValue({}),
        recentCwds: vi.fn().mockResolvedValue([]),
        topModel: vi.fn().mockResolvedValue(null),
        models: { list: vi.fn().mockResolvedValue([]) },
        connection: { read: vi.fn().mockResolvedValue(null) },
      },
    };
    const { useStore, hydrateStore } = await import('../src/stores/store');
    await hydrateStore();
    expect(useStore.getState().globalThinkingDefault).toBe('think_harder');
    expect(useStore.getState().thinkingLevelBySession['s-old']).toBe('think_harder');
  });
});

describe('slash-command registry: /think removed', () => {
  // The dedicated /think slash + Switch facsimile was retired when the
  // StatusBar Thinking chip dropdown landed. Two doors for the same
  // 5-state setting confused users (input "/think" + Enter silently
  // toggled with no visible feedback once the picker closed). Keep this
  // assertion so a future re-introduction has to actively delete it.
  it('does not register a `/think` built-in', async () => {
    vi.resetModules();
    const { BUILT_IN_COMMANDS } = await import('../src/slash-commands/registry');
    expect(BUILT_IN_COMMANDS.find((c) => c.name === 'think')).toBeUndefined();
  });
});
