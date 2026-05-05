// Task #601 / spec §5.3.2 PR-2 acceptance UT (audit Variant A,
// docs/audit/2026-05-06-ccsmstore-eval-order.md).
//
// Verifies that `window.__ccsmStore` is pinned synchronously at the
// moment `src/stores/store.ts` is evaluated — i.e. before any awaited
// hydrate / shim work, and without any consumer of the store needing
// to import App.tsx first. Regression armor against root cause A
// from spec §1.2.1 / §2.2 (pin trapped behind an awaited block that
// can throw, leaving `__ccsmStore` undefined → `seedStore` HP-1
// timeout).
//
// The contract: `await import('../src/stores/store')` is sufficient
// to make `globalThis.__ccsmStore === useStore` observable. No React
// tree, no installCcsmShim, no hydrateStore needed.
import { describe, it, expect, beforeEach } from 'vitest';

describe('store: window.__ccsmStore is pinned at module eval', () => {
  beforeEach(() => {
    // Sanity: clear any previous pin so the import below is the only
    // thing that could legally restore it.
    delete (globalThis as unknown as { __ccsmStore?: unknown }).__ccsmStore;
  });

  it('pins `useStore` on `window` synchronously when the store module is imported', async () => {
    expect(
      (globalThis as unknown as { __ccsmStore?: unknown }).__ccsmStore
    ).toBeUndefined();

    // Importing the store module is the only thing the test does.
    // No App.tsx, no installCcsmShim, no hydrateStore. If the pin
    // ever moves back to a deferred / awaited code path, this assertion
    // flips and the spec §5.3.2 contract is violated.
    const mod = await import('../src/stores/store');

    const pinned = (globalThis as unknown as { __ccsmStore?: unknown })
      .__ccsmStore;
    expect(pinned).toBeDefined();
    expect(pinned).toBe(mod.useStore);
  });
});
