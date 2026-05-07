import { describe, it, expect } from 'vitest';
import {
  FrameType,
  decodeExit,
  decodeFrame,
  decodeResize,
  encodeExit,
  encodeFrame,
  encodeResize,
} from '@ccsm/shared';

// T6 reuses the T2 frame codec from @ccsm/shared verbatim — no fork. These
// tests assert the import path resolves AND that round-trips for every frame
// type the frontend touches (INPUT/OUTPUT/RESIZE/EXIT) work end-to-end.
describe('frame codec (shared) — frontend round-trip', () => {
  it('round-trips an INPUT frame with text payload', () => {
    const payload = new TextEncoder().encode('echo hello\n');
    const buf = encodeFrame({ type: FrameType.INPUT, seq: 7, payload });
    const decoded = decodeFrame(buf);
    expect(decoded.type).toBe(FrameType.INPUT);
    expect(decoded.seq).toBe(7);
    expect(new TextDecoder().decode(decoded.payload)).toBe('echo hello\n');
  });

  it('round-trips an OUTPUT frame with binary payload', () => {
    const payload = new Uint8Array([0x1b, 0x5b, 0x33, 0x32, 0x6d, 0x6f, 0x6b]);
    const buf = encodeFrame({ type: FrameType.OUTPUT, seq: 0, payload });
    const decoded = decodeFrame(buf);
    expect(decoded.type).toBe(FrameType.OUTPUT);
    expect(decoded.seq).toBe(0);
    expect(Array.from(decoded.payload)).toEqual(Array.from(payload));
  });

  it('round-trips a RESIZE payload (cols/rows u16 BE)', () => {
    const payload = encodeResize(132, 43);
    const buf = encodeFrame({ type: FrameType.RESIZE, seq: 1, payload });
    const decoded = decodeFrame(buf);
    expect(decoded.type).toBe(FrameType.RESIZE);
    expect(decodeResize(decoded.payload)).toEqual({ cols: 132, rows: 43 });
  });

  it('round-trips an EXIT payload (code u32 BE)', () => {
    const payload = encodeExit(137);
    const buf = encodeFrame({ type: FrameType.EXIT, seq: 99, payload });
    const decoded = decodeFrame(buf);
    expect(decoded.type).toBe(FrameType.EXIT);
    expect(decoded.seq).toBe(99);
    expect(decodeExit(decoded.payload)).toEqual({ code: 137 });
  });
});
