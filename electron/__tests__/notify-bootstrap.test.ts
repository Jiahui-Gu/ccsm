import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  bootstrapNotify,
  registerToastTarget,
  lookupToastTarget,
  consumeToastTarget,
  __resetBootstrapForTests,
} from '../notify-bootstrap';
import { __setNotifyImporter } from '../notify';

// Stub electron's BrowserWindow surface — the test process is plain node so
// importing `electron` would attempt to resolve the binary. We only need
// `getAllWindows` for `shouldSuppressForFocus`, which our tests don't exercise
// here (covered in the e2e probe instead).
vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: () => [] },
}));

describe('notify-bootstrap', () => {
  beforeEach(() => {
    __resetBootstrapForTests();
    __setNotifyImporter(null);
  });

  it('bootstrapNotify is a no-op on non-win32 and never throws', () => {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
    try {
      // Router never gets called because we early-return; passing a throwing
      // router proves the no-op path doesn't invoke it.
      const router = vi.fn(() => {
        throw new Error('should not fire');
      });
      const result = bootstrapNotify(router);
      expect(result).toBe(false);
      expect(router).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: original, configurable: true });
    }
  });

  it('toast target registry round-trips a single entry', () => {
    registerToastTarget('toast-1', 'session-A', 'permission');
    const t = lookupToastTarget('toast-1');
    expect(t).toEqual({ sessionId: 'session-A', kind: 'permission' });
    consumeToastTarget('toast-1');
    expect(lookupToastTarget('toast-1')).toBeUndefined();
  });

  it('registry evicts the oldest entry when the cap is exceeded', () => {
    // Cap is 256 (private constant); seed 257 entries and assert the first
    // one is gone. Iteration order on Map is insertion order in JS.
    for (let i = 0; i < 257; i++) {
      registerToastTarget(`toast-${i}`, `session-${i}`, 'turn_done');
    }
    expect(lookupToastTarget('toast-0')).toBeUndefined();
    expect(lookupToastTarget('toast-256')).toBeDefined();
    // Cleanup so other tests aren't polluted.
    for (let i = 1; i < 257; i++) consumeToastTarget(`toast-${i}`);
  });

  it('bootstrapNotify is idempotent — second call leaves the first router intact', () => {
    if (process.platform !== 'win32') return; // win32-only path
    const r1 = vi.fn();
    const r2 = vi.fn();
    expect(bootstrapNotify(r1)).toBe(true);
    // Second call should not replace r1 (we deliberately freeze the router so
    // in-flight toasts can't be orphaned by a re-bootstrap).
    expect(bootstrapNotify(r2)).toBe(true);
    // The wrapper would call r1 on activation; r2 must remain unused.
    expect(r2).not.toHaveBeenCalled();
  });
});
