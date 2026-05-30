import { describe, it, expect } from 'vitest';
import { encodeWav } from '../wavEncoder';

describe('encodeWav', () => {
  it('writes a canonical 16kHz mono 16-bit WAV header and data', () => {
    const pcm = new Float32Array([0, 0.5, -0.5, 1, -1]);
    const buf = encodeWav(pcm, 16000);

    // header fields
    expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
    expect(buf.toString('ascii', 8, 12)).toBe('WAVE');
    expect(buf.toString('ascii', 12, 16)).toBe('fmt ');
    expect(buf.readUInt32LE(16)).toBe(16); // fmt chunk size
    expect(buf.readUInt16LE(20)).toBe(1); // PCM
    expect(buf.readUInt16LE(22)).toBe(1); // mono
    expect(buf.readUInt32LE(24)).toBe(16000); // sample rate
    expect(buf.readUInt16LE(34)).toBe(16); // bits per sample
    expect(buf.toString('ascii', 36, 40)).toBe('data');

    // data length = samples * 2 bytes
    expect(buf.readUInt32LE(40)).toBe(pcm.length * 2);
    expect(buf.length).toBe(44 + pcm.length * 2);

    // RIFF chunk size = file length - 8
    expect(buf.readUInt32LE(4)).toBe(buf.length - 8);

    // sample scaling: 0 -> 0, 1 -> 32767, -1 -> -32768
    expect(buf.readInt16LE(44)).toBe(0);
    expect(buf.readInt16LE(44 + 6)).toBe(32767); // 4th sample = 1.0
    expect(buf.readInt16LE(44 + 8)).toBe(-32768); // 5th sample = -1.0
  });
});
