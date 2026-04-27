import { describe, it, expect } from 'vitest';
import {
  CLI_PICKER_MODELS,
  getCustomEnvOverrides,
  type CliPickerModel,
} from '../cli-picker-models';

describe('CLI_PICKER_MODELS', () => {
  it('contains at least the 7 picker entries from claude.exe v2.1.114', () => {
    expect(CLI_PICKER_MODELS.length).toBeGreaterThanOrEqual(7);
  });

  it('exposes the canonical alias entries', () => {
    const ids = CLI_PICKER_MODELS.map((m) => m.id);
    for (const id of [
      'sonnet',
      'opus',
      'haiku',
      'sonnet[1m]',
      'opus[1m]',
      'claude-opus-4-6[1m]',
      'claude-opus-4-1',
    ]) {
      expect(ids).toContain(id);
    }
  });

  it('every entry has non-empty id, label, description (shape check)', () => {
    for (const m of CLI_PICKER_MODELS) {
      expect(typeof m.id).toBe('string');
      expect(m.id.trim().length).toBeGreaterThan(0);
      expect(typeof m.label).toBe('string');
      expect(m.label.trim().length).toBeGreaterThan(0);
      expect(typeof m.description).toBe('string');
      expect(m.description.trim().length).toBeGreaterThan(0);
    }
  });

  it('is readonly at runtime — entries cannot be mutated', () => {
    const first = CLI_PICKER_MODELS[0] as CliPickerModel;
    expect(() => {
      // Bypass TS to verify runtime freeze
      (first as unknown as Record<string, string>).id = 'mutated';
    }).toThrow(TypeError);
    expect(CLI_PICKER_MODELS[0].id).not.toBe('mutated');
  });

  it('the array itself is frozen (cannot push)', () => {
    expect(() => {
      (CLI_PICKER_MODELS as unknown as CliPickerModel[]).push({
        id: 'x',
        label: 'x',
        description: 'x',
      });
    }).toThrow(TypeError);
  });
});

describe('getCustomEnvOverrides', () => {
  it('returns empty array when no tier env vars are set', () => {
    expect(getCustomEnvOverrides({})).toEqual([]);
  });

  it('emits a single Sonnet override when only ANTHROPIC_DEFAULT_SONNET_MODEL is set', () => {
    const out = getCustomEnvOverrides({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'my-sonnet-id',
    });
    expect(out).toEqual([
      { id: 'my-sonnet-id', label: 'Custom Sonnet model', description: '' },
    ]);
  });

  it('emits all three when all tier vars are set, in Sonnet/Opus/Haiku order', () => {
    const out = getCustomEnvOverrides({
      ANTHROPIC_DEFAULT_SONNET_MODEL: 's',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'o',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
    });
    expect(out.map((m) => m.id)).toEqual(['s', 'o', 'h']);
    expect(out[0].label).toBe('Custom Sonnet model');
    expect(out[1].label).toBe('Custom Opus model');
    expect(out[2].label).toBe('Custom Haiku model');
  });

  it('honours optional NAME and DESCRIPTION companion vars', () => {
    const out = getCustomEnvOverrides({
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'opus-id',
      ANTHROPIC_DEFAULT_OPUS_MODEL_NAME: 'My Opus',
      ANTHROPIC_DEFAULT_OPUS_MODEL_DESCRIPTION: 'Tuned for code',
    });
    expect(out).toEqual([
      { id: 'opus-id', label: 'My Opus', description: 'Tuned for code' },
    ]);
  });

  it('treats whitespace-only tier values as unset', () => {
    expect(
      getCustomEnvOverrides({
        ANTHROPIC_DEFAULT_SONNET_MODEL: '   ',
      }),
    ).toEqual([]);
  });

  it('falls back to default label when only DESCRIPTION companion is set', () => {
    const out = getCustomEnvOverrides({
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'h',
      ANTHROPIC_DEFAULT_HAIKU_MODEL_DESCRIPTION: 'fast',
    });
    expect(out).toEqual([
      { id: 'h', label: 'Custom Haiku model', description: 'fast' },
    ]);
  });

  it('trims id / label / description values', () => {
    const out = getCustomEnvOverrides({
      ANTHROPIC_DEFAULT_SONNET_MODEL: '  trimmed-id  ',
      ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: '  Trimmed Name  ',
      ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: '  desc  ',
    });
    expect(out).toEqual([
      { id: 'trimmed-id', label: 'Trimmed Name', description: 'desc' },
    ]);
  });
});
