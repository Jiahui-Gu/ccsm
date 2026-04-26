import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  coerceEffortLevel,
  DEFAULT_EFFORT_LEVEL,
  isEffortLevelSupported,
  projectEffortToWire,
  supportedEffortLevelsForModel,
  thinkingTokensForLevel,
} from '../src/agent/effort';

describe('effort: projectEffortToWire', () => {
  it('Off => thinking disabled, effort omitted', () => {
    expect(projectEffortToWire('off')).toEqual({ thinking: { type: 'disabled' } });
  });

  it.each(['low', 'medium', 'high', 'xhigh', 'max'] as const)(
    '%s => thinking adaptive + effort=<level>',
    (lvl) => {
      expect(projectEffortToWire(lvl)).toEqual({
        thinking: { type: 'adaptive' },
        effort: lvl,
      });
    },
  );
});

describe('effort: thinkingTokensForLevel', () => {
  it('off -> 0 (disable thinking)', () => {
    expect(thinkingTokensForLevel('off')).toBe(0);
  });
  it('every other tier -> null (enable adaptive thinking)', () => {
    for (const lvl of ['low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(thinkingTokensForLevel(lvl)).toBeNull();
    }
  });
});

describe('effort: model gating', () => {
  it('Opus 4.7 supports all 5 non-Off tiers', () => {
    const ids = ['claude-opus-4-7', 'claude-opus-4.7', 'opus-4-7-20251111'];
    for (const id of ids) {
      const set = supportedEffortLevelsForModel(id);
      expect(set.has('low')).toBe(true);
      expect(set.has('medium')).toBe(true);
      expect(set.has('high')).toBe(true);
      expect(set.has('xhigh')).toBe(true);
      expect(set.has('max')).toBe(true);
    }
  });

  it('Opus 4.6 supports low/medium/high/max but NOT xhigh', () => {
    const set = supportedEffortLevelsForModel('claude-opus-4-6');
    expect(set.has('xhigh')).toBe(false);
    expect(set.has('max')).toBe(true);
    expect(set.has('high')).toBe(true);
  });

  it('Sonnet supports low/medium/high but NOT xhigh or max', () => {
    const set = supportedEffortLevelsForModel('claude-sonnet-4-6');
    expect(set.has('xhigh')).toBe(false);
    expect(set.has('max')).toBe(false);
    expect(set.has('high')).toBe(true);
  });

  it('Off is always selectable regardless of model', () => {
    expect(isEffortLevelSupported('claude-haiku-4-5', 'off')).toBe(true);
    expect(isEffortLevelSupported(undefined, 'off')).toBe(true);
    expect(isEffortLevelSupported(null, 'off')).toBe(true);
  });

  it('SDK-reported tiers OVERRIDE the hardcoded fallback', () => {
    // Sonnet hardcoded -> [low,medium,high]. SDK report grants xhigh too.
    const sdk = { 'claude-sonnet-4-99': ['low', 'medium', 'high', 'xhigh'] as const };
    const set = supportedEffortLevelsForModel('claude-sonnet-4-99', sdk);
    expect(set.has('xhigh')).toBe(true);
    expect(set.has('max')).toBe(false);
    // isEffortLevelSupported respects the override too.
    expect(isEffortLevelSupported('claude-sonnet-4-99', 'xhigh', sdk)).toBe(true);
    expect(isEffortLevelSupported('claude-sonnet-4-99', 'max', sdk)).toBe(false);
  });

  it('Falls back to hardcoded table when SDK has no entry for the model', () => {
    const sdk = { 'some-other-model': ['low'] as const };
    const set = supportedEffortLevelsForModel('claude-opus-4-7', sdk);
    expect(set.has('xhigh')).toBe(true);
    expect(set.has('max')).toBe(true);
  });

  it('SDK lookup is case-insensitive on the model id', () => {
    const sdk = { 'Custom-Model-X': ['low', 'medium'] as const };
    const set = supportedEffortLevelsForModel('custom-model-x', sdk);
    expect(set.has('low')).toBe(true);
    expect(set.has('medium')).toBe(true);
    expect(set.has('high')).toBe(false);
  });

  it('Empty SDK report falls through to hardcoded fallback (no spurious empty set)', () => {
    const sdk = { 'claude-opus-4-7': [] as const };
    const set = supportedEffortLevelsForModel('claude-opus-4-7', sdk);
    // Empty array shouldn't lock the chip out; treat as "no info" and fall back.
    expect(set.has('high')).toBe(true);
  });
});

describe('effort: coerceEffortLevel migration', () => {
  it('coerces unrecognised legacy values to default High', () => {
    expect(coerceEffortLevel(undefined)).toBe('high');
    expect(coerceEffortLevel(null)).toBe('high');
    expect(coerceEffortLevel('default_on')).toBe('high'); // legacy ThinkingLevel
    expect(coerceEffortLevel('off_on')).toBe('high');
    expect(coerceEffortLevel(42)).toBe('high');
    expect(DEFAULT_EFFORT_LEVEL).toBe('high');
  });

  it('round-trips every valid 6-tier value', () => {
    for (const lvl of ['off', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
      expect(coerceEffortLevel(lvl)).toBe(lvl);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────
// Store-action coverage. Focuses on the IPC fan-out + per-session vs global
// state separation.
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

describe('store: effort-level actions', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('default global is High and per-session map starts empty', async () => {
    const { useStore } = await freshStore({});
    expect(useStore.getState().globalEffortLevel).toBe('high');
    expect(useStore.getState().effortLevelBySession).toEqual({});
  });

  it('setEffortLevel updates per-session state without IPC for unstarted sessions', async () => {
    const agentSetEffort = vi.fn().mockResolvedValue({ ok: true });
    const { useStore } = await freshStore({ agentSetEffort });
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setEffortLevel(sid, 'max');
    expect(useStore.getState().effortLevelBySession[sid]).toBe('max');
    // Session not started => no IPC.
    expect(agentSetEffort).not.toHaveBeenCalled();
  });

  it('setEffortLevel pushes IPC when session is started', async () => {
    const agentSetEffort = vi.fn().mockResolvedValue({ ok: true });
    const { useStore } = await freshStore({ agentSetEffort });
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().markStarted(sid);
    useStore.getState().setEffortLevel(sid, 'max');
    expect(agentSetEffort).toHaveBeenCalledWith(sid, 'max');
    useStore.getState().setEffortLevel(sid, 'off');
    expect(agentSetEffort).toHaveBeenLastCalledWith(sid, 'off');
  });

  it('setGlobalEffortLevel does NOT rewrite per-session overrides', async () => {
    const { useStore } = await freshStore({});
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setEffortLevel(sid, 'low');
    useStore.getState().setGlobalEffortLevel('max');
    expect(useStore.getState().globalEffortLevel).toBe('max');
    expect(useStore.getState().effortLevelBySession[sid]).toBe('low');
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
    useStore.getState().setGlobalEffortLevel('xhigh');
    useStore.getState().setEffortLevel('s-1', 'max');
    vi.advanceTimersByTime(500);
    expect(saveState).toHaveBeenCalled();
    const last = saveState.mock.calls[saveState.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(last[1]);
    expect(parsed.globalEffortLevel).toBe('xhigh');
    expect(parsed.effortLevelBySession).toEqual({ 's-1': 'max' });
  });

  it('migration: legacy thinkingDepth/globalThinkingDefault fall back to High default', async () => {
    vi.resetModules();
    const stale = JSON.stringify({
      version: 1,
      sessions: [],
      groups: [],
      activeId: '',
      model: '',
      permission: 'default',
      sidebarCollapsed: false,
      // Legacy keys that should be ignored on hydrate.
      globalThinkingDefault: 'default_on',
      thinkingLevelBySession: { 's-old': 'default_on' },
    });
    (globalThis as unknown as { window?: unknown }).window = {
      ccsm: {
        saveState: vi.fn().mockResolvedValue(undefined),
        loadState: vi.fn().mockResolvedValue(stale),
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
    expect(useStore.getState().globalEffortLevel).toBe('high');
    expect(useStore.getState().effortLevelBySession).toEqual({});
  });
});

describe('store: applyModelInfo (SDK-reported supportedEffortLevels)', () => {
  it('populates supportedEffortLevelsByModel from agent:modelInfo payload', async () => {
    const { useStore } = await freshStore({});
    expect(useStore.getState().supportedEffortLevelsByModel).toEqual({});
    useStore.getState().applyModelInfo([
      { modelId: 'claude-opus-4-7', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
      { modelId: 'claude-sonnet-4-6', supportedEffortLevels: ['low', 'medium', 'high'] },
    ]);
    const m = useStore.getState().supportedEffortLevelsByModel;
    expect(m['claude-opus-4-7']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(m['claude-sonnet-4-6']).toEqual(['low', 'medium', 'high']);
  });

  it('ignores empty / malformed payloads without clobbering existing entries', async () => {
    const { useStore } = await freshStore({});
    useStore.getState().applyModelInfo([
      { modelId: 'claude-opus-4-7', supportedEffortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
    ]);
    // Empty list — no-op.
    useStore.getState().applyModelInfo([]);
    // Malformed entries — skipped.
    useStore
      .getState()
      .applyModelInfo([
        { modelId: '', supportedEffortLevels: ['low'] } as never,
        // unknown tier strings are filtered out by the reducer's allow-list.
        { modelId: 'claude-bad', supportedEffortLevels: ['bogus' as never, 'high'] },
      ]);
    const m = useStore.getState().supportedEffortLevelsByModel;
    expect(m['claude-opus-4-7']).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(m['claude-bad']).toEqual(['high']);
    expect(m['']).toBeUndefined();
  });
});
