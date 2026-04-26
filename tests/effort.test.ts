import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  coerceEffortLevel,
  DEFAULT_EFFORT_LEVEL,
  isEffortRejectionError,
  nextLowerEffort,
  projectEffortToWire,
  thinkingTokensForLevel,
  type EffortLevel,
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

describe('effort: nextLowerEffort fallback ladder', () => {
  it('walks max -> xhigh -> high -> medium -> low -> off -> null', () => {
    const ladder: Array<EffortLevel | null> = [
      'max',
      'xhigh',
      'high',
      'medium',
      'low',
      'off',
      null,
    ];
    for (let i = 0; i < ladder.length - 1; i++) {
      expect(nextLowerEffort(ladder[i] as EffortLevel)).toBe(ladder[i + 1]);
    }
  });

  it('off is the bottom of the ladder', () => {
    expect(nextLowerEffort('off')).toBeNull();
  });
});

describe('effort: isEffortRejectionError', () => {
  it.each([
    'effort level "max" is not supported by this model',
    'Invalid effort tier',
    'effortLevel: unknown value',
    'unsupported effort',
    'thinking is not supported',
    'invalid thinking config',
  ])('classifies CLI effort rejection: %s', (msg) => {
    expect(isEffortRejectionError(new Error(msg))).toBe(true);
  });

  it.each([
    'connection refused',
    'session aborted',
    'permission denied for tool Bash',
    '',
    'something else entirely',
  ])('does NOT classify unrelated error: %s', (msg) => {
    expect(isEffortRejectionError(new Error(msg))).toBe(false);
  });

  it('handles non-Error inputs without throwing', () => {
    expect(isEffortRejectionError(null)).toBe(false);
    expect(isEffortRejectionError(undefined)).toBe(false);
    expect(isEffortRejectionError('effort unsupported')).toBe(true);
    expect(isEffortRejectionError(42)).toBe(false);
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
      defaultModel: vi.fn().mockResolvedValue(null),
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
        defaultModel: vi.fn().mockResolvedValue(null),
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
        defaultModel: vi.fn().mockResolvedValue(null),
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

