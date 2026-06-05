import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, waitFor, act, fireEvent, cleanup, within } from '@testing-library/react';
import React from 'react';
import { VoicePane } from '../../src/components/settings/VoicePane';
import type { VoiceTier, VoiceLanguage, VoiceModelStatus } from '../../src/global';

// In-memory renderer bridges VoicePane reads: window.ccsm (loadState/saveState
// for the selected tier and language) and window.ccsmVoice (per-tier downloaded
// check + download/cancel + status push hook).
function makeBridges(opts?: {
  selectedTier?: VoiceTier;
  selectedLanguage?: VoiceLanguage;
  downloaded?: Partial<Record<VoiceTier, boolean>>;
}) {
  const saveState = vi.fn(async () => {});
  const downloadModel = vi.fn(async () => null);
  const cancelDownload = vi.fn(async () => {});
  let pushCb: ((s: VoiceModelStatus) => void) | null = null;

  const ccsm = {
    loadState: vi.fn(async (key: string) => {
      if (key === 'voiceTier') return opts?.selectedTier ?? 'base';
      if (key === 'voiceLanguage') return opts?.selectedLanguage;
      return undefined;
    }),
    saveState,
  } as unknown as Window['ccsm'];

  const ccsmVoice = {
    transcribe: vi.fn(),
    isModelDownloaded: vi.fn(async (tier: VoiceTier) => opts?.downloaded?.[tier] ?? false),
    downloadModel,
    cancelDownload,
    onModelStatus: (cb: (s: VoiceModelStatus) => void) => {
      pushCb = cb;
      return () => {
        pushCb = null;
      };
    },
  } as unknown as Window['ccsmVoice'];

  return {
    ccsm,
    ccsmVoice,
    spies: { saveState, downloadModel, cancelDownload },
    push: (s: VoiceModelStatus) => pushCb?.(s),
  };
}

let current: ReturnType<typeof makeBridges>;

beforeEach(() => {
  current = makeBridges();
  (window as { ccsm?: unknown }).ccsm = current.ccsm;
  (window as { ccsmVoice?: unknown }).ccsmVoice = current.ccsmVoice;
});

afterEach(() => {
  cleanup();
  delete (window as { ccsm?: unknown }).ccsm;
  delete (window as { ccsmVoice?: unknown }).ccsmVoice;
});

async function renderPane() {
  await act(async () => {
    render(<VoicePane />);
  });
}

// Both the tier list and the language picker use role="radio". Scope tier-only
// assertions to the tier radiogroup so they don't miscount the 3 language
// radios added below it.
function tierRadios(): HTMLElement[] {
  return screen
    .getAllByRole('radio')
    .filter((el) => !el.closest('[data-voice-language]'));
}

describe('VoicePane', () => {
  it('renders all six tiers as radios', async () => {
    await renderPane();
    await waitFor(() => {
      expect(tierRadios()).toHaveLength(6);
    });
    for (const tier of ['tiny', 'base', 'small', 'medium', 'large-v3', 'large-v3-turbo']) {
      expect(screen.getByText(tier)).toBeInTheDocument();
    }
  });

  it('marks the stored tier as selected (aria-checked)', async () => {
    current = makeBridges({ selectedTier: 'small', downloaded: { small: true } });
    (window as { ccsm?: unknown }).ccsm = current.ccsm;
    (window as { ccsmVoice?: unknown }).ccsmVoice = current.ccsmVoice;
    await renderPane();
    await waitFor(() => {
      const small = screen.getByText('small').closest('[role="radio"]');
      expect(small?.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('shows a Download button for an un-downloaded tier and calls downloadModel', async () => {
    await renderPane();
    const buttons = await screen.findAllByRole('button', { name: 'Download' });
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    expect(current.spies.downloadModel).toHaveBeenCalledTimes(1);
  });

  it('selecting a downloaded tier persists voiceTier', async () => {
    current = makeBridges({ selectedTier: 'base', downloaded: { tiny: true } });
    (window as { ccsm?: unknown }).ccsm = current.ccsm;
    (window as { ccsmVoice?: unknown }).ccsmVoice = current.ccsmVoice;
    await renderPane();

    const useBtn = await screen.findByRole('button', { name: 'Use' });
    await act(async () => {
      fireEvent.click(useBtn);
    });
    expect(current.spies.saveState).toHaveBeenCalledWith('voiceTier', 'tiny');
  });

  it('renders a progress bar + Cancel when a download status arrives', async () => {
    await renderPane();
    await waitFor(() => expect(tierRadios()).toHaveLength(6));

    act(() => {
      current.push({ kind: 'downloading', tier: 'tiny', transferred: 1000, total: 4000 });
    });

    const cancelBtn = await screen.findByRole('button', { name: 'Cancel' });
    await act(async () => {
      fireEvent.click(cancelBtn);
    });
    expect(current.spies.cancelDownload).toHaveBeenCalledWith('tiny');
  });

  it('treats a zero Content-Length total as indeterminate (full-bar, no Infinity)', async () => {
    const { container } = await act(async () => render(<VoicePane />));
    await waitFor(() => expect(tierRadios()).toHaveLength(6));

    act(() => {
      // Content-Length: 0 → total === 0. transferred/0 would be Infinity; the
      // bar must fall back to the indeterminate full-bar branch instead.
      current.push({ kind: 'downloading', tier: 'tiny', transferred: 0, total: 0 });
    });

    const bar = container.querySelector('.bg-accent') as HTMLElement | null;
    expect(bar).not.toBeNull();
    expect(bar?.style.width).toBe('100%');
  });

  it('a ready status flips the tier to installed (Use button appears)', async () => {
    await renderPane();
    await waitFor(() => expect(tierRadios()).toHaveLength(6));

    act(() => {
      current.push({ kind: 'ready', tier: 'tiny' });
    });
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Use' })).toBeInTheDocument();
    });
  });
});

describe('VoicePane language selector', () => {
  // i18n is initialized to 'en' in tests/setup.ts, so the locale default is
  // 'auto' and the labels render as 'Auto-detect' / '中文' / 'English'.
  function languageGroup(container: HTMLElement): HTMLElement {
    const group = container.querySelector('[data-voice-language]') as HTMLElement | null;
    if (!group) throw new Error('language selector not rendered');
    return group;
  }

  it('renders the three language options as radios', async () => {
    const { container } = await act(async () => render(<VoicePane />));
    await waitFor(() => {
      const group = languageGroup(container);
      expect(group.querySelectorAll('[role="radio"]')).toHaveLength(3);
    });
    const group = languageGroup(container);
    for (const label of ['Auto-detect', '中文', 'English']) {
      expect(within(group).getByText(label)).toBeInTheDocument();
    }
  });

  it('marks the stored language as checked (aria-checked)', async () => {
    current = makeBridges({ selectedLanguage: 'zh' });
    (window as { ccsm?: unknown }).ccsm = current.ccsm;
    (window as { ccsmVoice?: unknown }).ccsmVoice = current.ccsmVoice;
    const { container } = await act(async () => render(<VoicePane />));
    await waitFor(() => {
      const zh = within(languageGroup(container)).getByText('中文').closest('[role="radio"]');
      expect(zh?.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('defaults to Auto-detect on the English locale when nothing is stored', async () => {
    const { container } = await act(async () => render(<VoicePane />));
    await waitFor(() => {
      const auto = within(languageGroup(container))
        .getByText('Auto-detect')
        .closest('[role="radio"]');
      expect(auto?.getAttribute('aria-checked')).toBe('true');
    });
  });

  it('picking a language persists voiceLanguage', async () => {
    const { container } = await act(async () => render(<VoicePane />));
    await waitFor(() => expect(languageGroup(container)).toBeInTheDocument());

    const zhRadio = within(languageGroup(container)).getByText('中文');
    await act(async () => {
      fireEvent.click(zhRadio);
    });
    expect(current.spies.saveState).toHaveBeenCalledWith('voiceLanguage', 'zh');

    const enRadio = within(languageGroup(container)).getByText('English');
    await act(async () => {
      fireEvent.click(enRadio);
    });
    expect(current.spies.saveState).toHaveBeenCalledWith('voiceLanguage', 'en');
  });
});
