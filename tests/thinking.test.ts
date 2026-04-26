import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  getMaxThinkingTokensForModel,
  toggleThinkingLevel,
} from '../src/agent/thinking';

describe('thinking: getMaxThinkingTokensForModel', () => {
  // The values here MUST stay in lock-step with upstream Claude Code VS Code
  // extension v2.1.120. If a future SDK bump changes the literal, regrep
  // `getMaxThinkingTokensForModel` in the bundled extension.js and update the
  // numeric expectations together with the implementation — never silently.
  it('returns 0 when level is off (regardless of model)', () => {
    expect(getMaxThinkingTokensForModel('claude-sonnet-4-5', 'off')).toBe(0);
    expect(getMaxThinkingTokensForModel('claude-opus-4-7', 'off')).toBe(0);
    expect(getMaxThinkingTokensForModel('claude-haiku-4-5', 'off')).toBe(0);
    expect(getMaxThinkingTokensForModel(undefined, 'off')).toBe(0);
  });

  it('returns the upstream literal (31999) when level is default_on', () => {
    expect(getMaxThinkingTokensForModel('claude-sonnet-4-5', 'default_on')).toBe(31999);
    expect(getMaxThinkingTokensForModel('claude-opus-4-7', 'default_on')).toBe(31999);
    expect(getMaxThinkingTokensForModel('claude-haiku-4-5', 'default_on')).toBe(31999);
    expect(getMaxThinkingTokensForModel(undefined, 'default_on')).toBe(31999);
  });
});

describe('thinking: toggleThinkingLevel', () => {
  it('round-trips off ↔ default_on', () => {
    expect(toggleThinkingLevel('off')).toBe('default_on');
    expect(toggleThinkingLevel('default_on')).toBe('off');
    expect(toggleThinkingLevel(toggleThinkingLevel('off'))).toBe('off');
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
    useStore.getState().setThinkingLevel(sid, 'default_on');
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('default_on');
    // No IPC fan-out yet — session is not started.
    expect(agentSetMaxThinkingTokens).not.toHaveBeenCalled();
  });

  it('setThinkingLevel pushes IPC when session is started', async () => {
    const agentSetMaxThinkingTokens = vi.fn().mockResolvedValue({ ok: true });
    const { useStore } = await freshStore({ agentSetMaxThinkingTokens });
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().markStarted(sid);
    useStore.getState().setThinkingLevel(sid, 'default_on');
    expect(agentSetMaxThinkingTokens).toHaveBeenCalledWith(sid, 31999);
    useStore.getState().setThinkingLevel(sid, 'off');
    expect(agentSetMaxThinkingTokens).toHaveBeenLastCalledWith(sid, 0);
  });

  it('setGlobalThinkingDefault updates global without touching per-session overrides', async () => {
    const { useStore } = await freshStore({});
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;
    useStore.getState().setThinkingLevel(sid, 'default_on');
    useStore.getState().setGlobalThinkingDefault('default_on');
    expect(useStore.getState().globalThinkingDefault).toBe('default_on');
    // Per-session override survives a global change.
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('default_on');
    useStore.getState().setGlobalThinkingDefault('off');
    expect(useStore.getState().globalThinkingDefault).toBe('off');
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('default_on');
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
    useStore.getState().setGlobalThinkingDefault('default_on');
    useStore.getState().setThinkingLevel('s-1', 'default_on');
    vi.advanceTimersByTime(500);
    expect(saveState).toHaveBeenCalled();
    const last = saveState.mock.calls[saveState.mock.calls.length - 1] as [string, string];
    const parsed = JSON.parse(last[1]);
    expect(parsed.globalThinkingDefault).toBe('default_on');
    expect(parsed.thinkingLevelBySession).toEqual({ 's-1': 'default_on' });
  });
});

describe('/think handler', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('toggles the active session level via the store action', async () => {
    const agentSetMaxThinkingTokens = vi.fn().mockResolvedValue({ ok: true });
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
        agentSetMaxThinkingTokens,
      },
    };
    const { useStore, hydrateStore } = await import('../src/stores/store');
    await hydrateStore();
    // Importing handlers attaches the clientHandler as a side-effect.
    const handlers = await import('../src/slash-commands/handlers');
    const { BUILT_IN_COMMANDS } = await import('../src/slash-commands/registry');
    useStore.getState().createSession('~/x');
    const sid = useStore.getState().sessions[0].id;

    // First /think on a fresh session (default off) → default_on.
    handlers.handleThink({ sessionId: sid, args: '' });
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('default_on');
    // Second /think → back off.
    handlers.handleThink({ sessionId: sid, args: '' });
    expect(useStore.getState().thinkingLevelBySession[sid]).toBe('off');

    // Wired into the registry as a built-in with passThrough=false.
    const think = BUILT_IN_COMMANDS.find((c) => c.name === 'think');
    expect(think?.passThrough).toBe(false);
    expect(typeof think?.clientHandler).toBe('function');
  });
});
