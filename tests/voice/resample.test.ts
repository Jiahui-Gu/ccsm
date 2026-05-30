import { describe, it, expect } from 'vitest';
import { resampleTo16k } from '../../src/voice/resample';

describe('resampleTo16k', () => {
  it('downsamples a 48kHz buffer to the expected 16kHz length', () => {
    const input = new Float32Array(48000); // 1 second @ 48kHz
    const out = resampleTo16k(input, 48000);
    // 1 second @ 16kHz = 16000 samples (±1 for rounding)
    expect(Math.abs(out.length - 16000)).toBeLessThanOrEqual(1);
  });

  it('returns the input unchanged when already 16kHz', () => {
    const input = new Float32Array([0.1, 0.2, 0.3]);
    const out = resampleTo16k(input, 16000);
    // same rate is a no-op: the exact same buffer is handed back.
    expect(out).toBe(input);
  });

  it('preserves a constant signal value after resampling', () => {
    const input = new Float32Array(48000).fill(0.5);
    const out = resampleTo16k(input, 48000);
    // linear interpolation of a constant stays constant
    expect(out[100]).toBeCloseTo(0.5, 5);
  });
});
