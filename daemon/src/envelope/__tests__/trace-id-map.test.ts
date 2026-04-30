import { describe, expect, it } from 'vitest';

import { isCarveOutFrameType, TraceIdMap } from '../trace-id-map.js';

describe('TraceIdMap', () => {
  it('register + resolve roundtrip returns the registered traceId', () => {
    const map = new TraceIdMap();
    map.register('1', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(map.resolve('1')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
  });

  it('resolve on unknown streamId returns undefined', () => {
    const map = new TraceIdMap();
    expect(map.resolve('999')).toBeUndefined();
  });

  it('release removes the entry so subsequent resolve returns undefined', () => {
    const map = new TraceIdMap();
    map.register('3', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(map.resolve('3')).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    map.release('3');
    expect(map.resolve('3')).toBeUndefined();
    expect(map.size()).toBe(0);
  });

  it('release on unknown streamId is a no-op (idempotent teardown)', () => {
    const map = new TraceIdMap();
    expect(() => map.release('does-not-exist')).not.toThrow();
    expect(map.size()).toBe(0);
  });

  it('re-register on the same streamId overwrites the prior traceId', () => {
    const map = new TraceIdMap();
    map.register('5', '01ARZ3NDEKTSV4RRFFQ69G5FAV');
    map.register('5', '01BX5ZZKBKACTAV9WEVGEMMVRZ');
    expect(map.resolve('5')).toBe('01BX5ZZKBKACTAV9WEVGEMMVRZ');
    expect(map.size()).toBe(1);
  });

  it('tracks multiple independent streams without cross-talk', () => {
    const map = new TraceIdMap();
    map.register('1', 'TRACE_A_AAAAAAAAAAAAAAAAAA');
    map.register('3', 'TRACE_B_BBBBBBBBBBBBBBBBBB');
    expect(map.resolve('1')).toBe('TRACE_A_AAAAAAAAAAAAAAAAAA');
    expect(map.resolve('3')).toBe('TRACE_B_BBBBBBBBBBBBBBBBBB');
    map.release('1');
    expect(map.resolve('1')).toBeUndefined();
    expect(map.resolve('3')).toBe('TRACE_B_BBBBBBBBBBBBBBBBBB');
    expect(map.size()).toBe(1);
  });
});

describe('isCarveOutFrameType', () => {
  it('returns true for chunk sub-frames (inherit traceId from map)', () => {
    expect(isCarveOutFrameType('chunk')).toBe(true);
  });

  it('returns true for heartbeat sub-frames (inherit traceId from map)', () => {
    expect(isCarveOutFrameType('heartbeat')).toBe(true);
  });

  it('returns false for data frames (carry own traceId, may rotate)', () => {
    expect(isCarveOutFrameType('data')).toBe(false);
  });
});
