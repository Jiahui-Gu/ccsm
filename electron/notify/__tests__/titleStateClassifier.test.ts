import { describe, it, expect } from 'vitest';
import { classifyTitleState } from '../titleStateClassifier';

describe('classifyTitleState', () => {
  it('classifies the sparkle leading glyph as idle', () => {
    expect(classifyTitleState('✳ Claude Code')).toBe('idle');
  });

  it('classifies braille leading glyphs as running', () => {
    // A handful of the spinner frames the CLI cycles through.
    expect(classifyTitleState('⠂ Claude Code')).toBe('running');
    expect(classifyTitleState('⠐ Claude Code')).toBe('running');
    expect(classifyTitleState('⠁ Claude Code')).toBe('running');
    expect(classifyTitleState('⣿ Claude Code')).toBe('running');
    expect(classifyTitleState('⠀ Claude Code')).toBe('running');
  });

  it('classifies plain "claude" (boot / exit) as unknown', () => {
    expect(classifyTitleState('claude')).toBe('unknown');
  });

  it('treats empty / nullish titles as unknown', () => {
    expect(classifyTitleState('')).toBe('unknown');
    expect(classifyTitleState(null)).toBe('unknown');
    expect(classifyTitleState(undefined)).toBe('unknown');
  });

  it('only inspects the leading codepoint — trailing text does not flip the classification', () => {
    expect(classifyTitleState('✳ anything else here')).toBe('idle');
    expect(classifyTitleState('⠂ another suffix')).toBe('running');
  });

  it('returns unknown when the leading glyph is something we do not recognise', () => {
    expect(classifyTitleState('Claude Code')).toBe('unknown');
    expect(classifyTitleState('💩 Claude Code')).toBe('unknown');
    expect(classifyTitleState('? Claude Code')).toBe('unknown');
  });
});
