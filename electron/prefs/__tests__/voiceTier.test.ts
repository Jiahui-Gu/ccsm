import { describe, it, expect, vi, beforeEach } from 'vitest';

// voiceTier reads app_state via ../db and subscribes to the stateSavedBus.
// Mock both so the test stays in-memory and deterministic.
const loadState = vi.fn();
let savedBusHandler: ((key: string) => void) | undefined;
const onStateSaved = vi.fn((h: (key: string) => void) => {
  savedBusHandler = h;
  return () => {
    savedBusHandler = undefined;
  };
});

vi.mock('../../db', () => ({ loadState: (...a: unknown[]) => loadState(...a) }));
vi.mock('../../shared/stateSavedBus', () => ({
  onStateSaved: (h: (key: string) => void) => onStateSaved(h),
}));

describe('voiceTier prefs', () => {
  beforeEach(() => {
    vi.resetModules();
    loadState.mockReset();
    onStateSaved.mockReset();
    savedBusHandler = undefined;
  });

  it('returns a stored valid tier', async () => {
    loadState.mockReturnValue('small');
    const { loadVoiceTier } = await import('../voiceTier');
    expect(loadVoiceTier()).toBe('small');
  });

  it('falls back to base for an unknown stored value', async () => {
    loadState.mockReturnValue('bogus');
    const { loadVoiceTier } = await import('../voiceTier');
    expect(loadVoiceTier()).toBe('base');
  });

  it('falls back to base when loadState throws', async () => {
    loadState.mockImplementation(() => {
      throw new Error('db down');
    });
    const { loadVoiceTier } = await import('../voiceTier');
    expect(loadVoiceTier()).toBe('base');
  });

  it('caches the first read (db hit once across calls)', async () => {
    loadState.mockReturnValue('medium');
    const { loadVoiceTier } = await import('../voiceTier');
    expect(loadVoiceTier()).toBe('medium');
    expect(loadVoiceTier()).toBe('medium');
    expect(loadState).toHaveBeenCalledTimes(1);
  });

  it('invalidateVoiceTierCache forces a re-read', async () => {
    loadState.mockReturnValueOnce('tiny').mockReturnValueOnce('large-v3');
    const { loadVoiceTier, invalidateVoiceTierCache } = await import('../voiceTier');
    expect(loadVoiceTier()).toBe('tiny');
    invalidateVoiceTierCache();
    expect(loadVoiceTier()).toBe('large-v3');
    expect(loadState).toHaveBeenCalledTimes(2);
  });

  it('subscription invalidates cache only on the voiceTier key', async () => {
    loadState.mockReturnValueOnce('tiny').mockReturnValueOnce('base');
    const { loadVoiceTier, subscribeVoiceTierInvalidation, VOICE_TIER_KEY } =
      await import('../voiceTier');
    subscribeVoiceTierInvalidation();
    expect(loadVoiceTier()).toBe('tiny');

    savedBusHandler?.('somethingElse');
    expect(loadVoiceTier()).toBe('tiny'); // still cached
    expect(loadState).toHaveBeenCalledTimes(1);

    savedBusHandler?.(VOICE_TIER_KEY);
    expect(loadVoiceTier()).toBe('base'); // re-read
    expect(loadState).toHaveBeenCalledTimes(2);
  });
});
