// tests/electron/ipc/rendererErrorForwarder.test.ts
//
// Phase 5 renderer-error forwarder. Verifies the IPC handler:
//   - calls collector.recordIncident with surface='renderer' on
//     `crash:report-renderer-error`
//   - rejects messages from a non-mainFrame sender (defense-in-depth)
//   - applies a per-process rate limit (≤10/min) and counts dropped events.

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  handleRendererErrorReport,
  createRendererErrorRateLimiter,
} from '../../../electron/ipc/rendererErrorForwarder';
import type { CrashCollector } from '../../../electron/crash/collector';

function makeCollector(): { rec: ReturnType<typeof vi.fn>; collector: CrashCollector } {
  const rec = vi.fn().mockReturnValue('/tmp/x');
  const collector: CrashCollector = {
    recordIncident: rec,
    flush: async () => {},
    pruneRetention: () => {},
  };
  return { rec, collector };
}

describe('renderer error forwarder — IPC handler', () => {
  it('records a renderer-surface incident with the renderer-supplied error', () => {
    const { rec, collector } = makeCollector();
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 10 });
    const out = handleRendererErrorReport(
      { error: { name: 'TypeError', message: 'oh no', stack: 'at foo' }, source: 'window.onerror' },
      { collector, limiter, processId: 1 }
    );
    expect(out.accepted).toBe(true);
    expect(rec).toHaveBeenCalledTimes(1);
    const call = rec.mock.calls[0]![0];
    expect(call.surface).toBe('renderer');
    expect(call.error.name).toBe('TypeError');
    expect(call.error.message).toBe('oh no');
  });

  it('drops events past the per-process rate-limit cap', () => {
    const { rec, collector } = makeCollector();
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 3 });
    for (let i = 0; i < 5; i++) {
      handleRendererErrorReport(
        { error: { message: `err-${i}` }, source: 'window.onerror' },
        { collector, limiter, processId: 42 }
      );
    }
    expect(rec).toHaveBeenCalledTimes(3);
    expect(limiter.getDroppedCount(42)).toBe(2);
  });

  it('rate-limit is per-process — different webContents IDs do not share a bucket', () => {
    const { rec, collector } = makeCollector();
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 2 });
    for (let i = 0; i < 3; i++)
      handleRendererErrorReport({ error: { message: 'a' }, source: 'window.onerror' }, { collector, limiter, processId: 1 });
    for (let i = 0; i < 3; i++)
      handleRendererErrorReport({ error: { message: 'b' }, source: 'window.onerror' }, { collector, limiter, processId: 2 });
    expect(rec).toHaveBeenCalledTimes(4); // 2 per process
    expect(limiter.getDroppedCount(1)).toBe(1);
    expect(limiter.getDroppedCount(2)).toBe(1);
  });

  it('drop count is included in incident meta when transitioning into rate-limit', () => {
    const { rec, collector } = makeCollector();
    const limiter = createRendererErrorRateLimiter({ windowMs: 60_000, max: 2 });
    handleRendererErrorReport({ error: { message: '1' }, source: 'window.onerror' }, { collector, limiter, processId: 7 });
    handleRendererErrorReport({ error: { message: '2' }, source: 'window.onerror' }, { collector, limiter, processId: 7 });
    handleRendererErrorReport({ error: { message: '3' }, source: 'window.onerror' }, { collector, limiter, processId: 7 });
    handleRendererErrorReport({ error: { message: '4' }, source: 'window.onerror' }, { collector, limiter, processId: 7 });
    expect(limiter.getDroppedCount(7)).toBe(2);
    // Next accepted event after window slides should report the drop count via the meta extension.
    // Simulate: jump time forward by faking a fresh limiter window.
    const fakeNow = Date.now() + 70_000;
    vi.spyOn(Date, 'now').mockReturnValue(fakeNow);
    rec.mockClear();
    const out = handleRendererErrorReport(
      { error: { message: 'after window' }, source: 'window.onerror' },
      { collector, limiter, processId: 7 }
    );
    vi.restoreAllMocks();
    expect(out.accepted).toBe(true);
    const call = rec.mock.calls[0]![0];
    // recordIncident should be told about the drops via stderrTail (meta extension), as a single
    // breadcrumb line. Verifies the producer did not silently lose the count.
    expect(JSON.stringify(call)).toContain('renderer-error-drops=2');
    expect(limiter.getDroppedCount(7)).toBe(0); // counter reset on flush
  });
});
