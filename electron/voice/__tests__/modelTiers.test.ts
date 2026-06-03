import { describe, it, expect } from 'vitest';
import {
  VOICE_TIERS,
  DEFAULT_TIER,
  HEAVY_TIERS,
  tierFilename,
  isVoiceTier,
  buildDownloadUrls,
  TIER_SIZE_BYTES,
  type VoiceTier,
} from '../modelTiers';

describe('VOICE_TIERS', () => {
  it('enumerates the six main tiers in order, no .en / quantized variants', () => {
    expect([...VOICE_TIERS]).toEqual([
      'tiny',
      'base',
      'small',
      'medium',
      'large-v3',
      'large-v3-turbo',
    ]);
  });

  it('defaults to base', () => {
    expect(DEFAULT_TIER).toBe('base');
    expect(VOICE_TIERS).toContain(DEFAULT_TIER);
  });

  it('marks only the GB-scale tiers as heavy', () => {
    expect([...HEAVY_TIERS]).toEqual(['medium', 'large-v3', 'large-v3-turbo']);
    for (const t of HEAVY_TIERS) expect(VOICE_TIERS).toContain(t);
  });

  it('has a display size for every tier', () => {
    for (const t of VOICE_TIERS) {
      expect(TIER_SIZE_BYTES[t]).toBeGreaterThan(0);
    }
  });
});

describe('tierFilename', () => {
  it('produces the ggml-<tier>.bin name', () => {
    expect(tierFilename('base')).toBe('ggml-base.bin');
    expect(tierFilename('large-v3-turbo')).toBe('ggml-large-v3-turbo.bin');
  });
});

describe('isVoiceTier', () => {
  it('accepts every known tier', () => {
    for (const t of VOICE_TIERS) expect(isVoiceTier(t)).toBe(true);
  });

  it('rejects unknown strings and non-strings', () => {
    expect(isVoiceTier('large')).toBe(false);
    expect(isVoiceTier('base.en')).toBe(false);
    expect(isVoiceTier('')).toBe(false);
    expect(isVoiceTier(null)).toBe(false);
    expect(isVoiceTier(42)).toBe(false);
    expect(isVoiceTier(undefined)).toBe(false);
  });
});

describe('buildDownloadUrls', () => {
  it('returns HuggingFace primary then hf-mirror fallback for the tier file', () => {
    const urls = buildDownloadUrls('base');
    expect(urls).toEqual([
      'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
      'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin',
    ]);
  });

  it('embeds the per-tier filename for every tier', () => {
    for (const t of VOICE_TIERS as readonly VoiceTier[]) {
      const urls = buildDownloadUrls(t);
      expect(urls).toHaveLength(2);
      for (const u of urls) expect(u.endsWith(`/${tierFilename(t)}`)).toBe(true);
    }
  });
});
