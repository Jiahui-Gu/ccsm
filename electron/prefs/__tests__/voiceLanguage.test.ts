import { describe, it, expect, vi, beforeEach } from 'vitest';

// voiceLanguage reads app_state via ../db, derives its default from the active
// UI language via ../i18n#getMainLanguage, and subscribes to the
// stateSavedBus. Mock all three so the test stays in-memory and deterministic.
const loadState = vi.fn();
let mainLanguage = 'en';
let savedBusHandler: ((key: string) => void) | undefined;
const onStateSaved = vi.fn((h: (key: string) => void) => {
  savedBusHandler = h;
  return () => {
    savedBusHandler = undefined;
  };
});

vi.mock('../../db', () => ({ loadState: (...a: unknown[]) => loadState(...a) }));
vi.mock('../../i18n', () => ({ getMainLanguage: () => mainLanguage }));
vi.mock('../../shared/stateSavedBus', () => ({
  onStateSaved: (h: (key: string) => void) => onStateSaved(h),
}));

describe('voiceLanguage prefs', () => {
  beforeEach(() => {
    vi.resetModules();
    loadState.mockReset();
    onStateSaved.mockReset();
    mainLanguage = 'en';
    savedBusHandler = undefined;
  });

  it('returns a stored valid language', async () => {
    loadState.mockReturnValue('en');
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('en');
  });

  it('defaults to zh when the UI language is Chinese and nothing is stored', async () => {
    mainLanguage = 'zh';
    loadState.mockReturnValue(undefined);
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('zh');
  });

  it('defaults to auto when the UI language is English and nothing is stored', async () => {
    mainLanguage = 'en';
    loadState.mockReturnValue(undefined);
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('auto');
  });

  it('falls back to the locale default for an unknown stored value', async () => {
    mainLanguage = 'zh';
    loadState.mockReturnValue('bogus');
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('zh');
  });

  it('falls back to the locale default when loadState throws', async () => {
    mainLanguage = 'en';
    loadState.mockImplementation(() => {
      throw new Error('db down');
    });
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('auto');
  });

  it('caches the first read (db hit once across calls)', async () => {
    loadState.mockReturnValue('zh');
    const { loadVoiceLanguage } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('zh');
    expect(loadVoiceLanguage()).toBe('zh');
    expect(loadState).toHaveBeenCalledTimes(1);
  });

  it('invalidateVoiceLanguageCache forces a re-read', async () => {
    loadState.mockReturnValueOnce('zh').mockReturnValueOnce('en');
    const { loadVoiceLanguage, invalidateVoiceLanguageCache } = await import('../voiceLanguage');
    expect(loadVoiceLanguage()).toBe('zh');
    invalidateVoiceLanguageCache();
    expect(loadVoiceLanguage()).toBe('en');
    expect(loadState).toHaveBeenCalledTimes(2);
  });

  it('subscription invalidates cache only on the voiceLanguage key', async () => {
    loadState.mockReturnValueOnce('zh').mockReturnValueOnce('auto');
    const { loadVoiceLanguage, subscribeVoiceLanguageInvalidation, VOICE_LANGUAGE_KEY } =
      await import('../voiceLanguage');
    subscribeVoiceLanguageInvalidation();
    expect(loadVoiceLanguage()).toBe('zh');

    savedBusHandler?.('somethingElse');
    expect(loadVoiceLanguage()).toBe('zh'); // still cached
    expect(loadState).toHaveBeenCalledTimes(1);

    savedBusHandler?.(VOICE_LANGUAGE_KEY);
    expect(loadVoiceLanguage()).toBe('auto'); // re-read
    expect(loadState).toHaveBeenCalledTimes(2);
  });
});
