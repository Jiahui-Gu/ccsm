// Unit tests for PendingRenameFlusherSink in isolation.
//
// The sink owns the `jsonlSeen` per-sid edge flag. We verify the
// edge-trigger semantics drive the injected flush callback exactly once
// on the first fileExists=true tick per sid.

import { describe, it, expect, vi } from 'vitest';
import { PendingRenameFlusherSink } from '../pendingRenameFlusher';
import type { FileTick } from '../fileSource';

function tick(sid: string, fileExists: boolean): FileTick {
  return { sid, text: fileExists ? '{}\n' : '', fileExists, ts: Date.now() };
}

describe('PendingRenameFlusherSink', () => {
  it('does not flush while the file is missing', () => {
    const flush = vi.fn();
    const sink = new PendingRenameFlusherSink(flush);
    sink.onTick(tick('s1', false));
    sink.onTick(tick('s1', false));
    expect(flush).not.toHaveBeenCalled();
  });

  it('flushes exactly once when the file first appears', () => {
    const flush = vi.fn();
    const sink = new PendingRenameFlusherSink(flush);
    sink.onTick(tick('s1', false));
    sink.onTick(tick('s1', true));
    sink.onTick(tick('s1', true));
    sink.onTick(tick('s1', true));
    expect(flush).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith('s1');
  });

  it('flushes on the very first tick when fileExists is already true', () => {
    const flush = vi.fn();
    const sink = new PendingRenameFlusherSink(flush);
    sink.onTick(tick('s1', true));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('tracks jsonlSeen per sid independently', () => {
    const flush = vi.fn();
    const sink = new PendingRenameFlusherSink(flush);
    sink.onTick(tick('A', true));
    sink.onTick(tick('B', true));
    expect(flush).toHaveBeenCalledTimes(2);
    expect(flush).toHaveBeenNthCalledWith(1, 'A');
    expect(flush).toHaveBeenNthCalledWith(2, 'B');
    // Subsequent ticks for either don't re-fire.
    sink.onTick(tick('A', true));
    sink.onTick(tick('B', true));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('forget(sid) re-arms the edge so the next first-appear ticks again', () => {
    const flush = vi.fn();
    const sink = new PendingRenameFlusherSink(flush);
    sink.onTick(tick('s1', true));
    expect(flush).toHaveBeenCalledTimes(1);
    sink.forget('s1');
    sink.onTick(tick('s1', true));
    expect(flush).toHaveBeenCalledTimes(2);
  });

  it('swallows synchronous errors from the flush callback', () => {
    const flush = vi.fn(function () {
      throw new Error('sync boom');
    });
    const sink = new PendingRenameFlusherSink(flush);
    expect(() => sink.onTick(tick('s1', true))).not.toThrow();
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('tolerates an async (rejected) flush callback', async () => {
    const flush = vi.fn(async function () {
      throw new Error('async boom');
    });
    const sink = new PendingRenameFlusherSink(flush);
    expect(() => sink.onTick(tick('s1', true))).not.toThrow();
    // Let the rejected promise settle without bubbling.
    await new Promise((r) => setImmediate(r));
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('setFlush swaps the callback for subsequent edge triggers', () => {
    const flushA = vi.fn();
    const flushB = vi.fn();
    const sink = new PendingRenameFlusherSink(flushA);
    sink.onTick(tick('s1', true));
    expect(flushA).toHaveBeenCalledTimes(1);
    sink.setFlush(flushB);
    // Already-seen sid won't re-fire; need a new sid.
    sink.onTick(tick('s2', true));
    expect(flushA).toHaveBeenCalledTimes(1);
    expect(flushB).toHaveBeenCalledTimes(1);
    expect(flushB).toHaveBeenCalledWith('s2');
  });
});
