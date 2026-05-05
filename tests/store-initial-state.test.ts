// Task #601 / spec §5.3.2 PR-2 acceptance UT (audit Variant A row,
// `tests/stores/initialState.test.ts` line in the audit table).
//
// Verifies that the fields App.tsx reads on its first paint exist on
// the store's initial (pre-hydrate) state. If a slice is ever
// refactored such that an App.tsx selector reads `undefined` before
// `hydrateStore()` resolves, React would render with garbage and the
// pre-hydrate skeleton branch would silently break — this UT pins the
// contract.
//
// Field list mirrors the `useStore((s) => s.X)` selectors in
// `src/App.tsx` body (lines 67-89 today). Add new selectors here when
// App.tsx grows new pre-hydrate reads.
import { describe, it, expect } from 'vitest';
import { useStore } from '../src/stores/store';

describe('store: initial state covers all App.tsx first-paint reads', () => {
  it('exposes the fields App.tsx selects from before hydrate resolves', () => {
    const s = useStore.getState();

    // Collections — must be arrays, not undefined, so .find / .map in
    // App.tsx don't NPE on the first render tick.
    expect(Array.isArray(s.sessions)).toBe(true);
    expect(Array.isArray(s.groups)).toBe(true);

    // Scalar selectors — defined (string / null / etc.), not undefined,
    // so React's "Rendered fewer hooks" / "received NaN" warnings can't
    // surface from a missing key.
    expect(s).toHaveProperty('activeId');
    expect(s).toHaveProperty('focusedGroupId');
    expect(s).toHaveProperty('flashStates');
    expect(s).toHaveProperty('theme');
    expect(s).toHaveProperty('fontSizePx');

    // `flashStates` is read by App.tsx's effect that projects to
    // `window.__ccsmFlashStates` — must be an object even pre-hydrate
    // so `Object.keys(flashStates)` doesn't throw.
    expect(typeof s.flashStates).toBe('object');
    expect(s.flashStates).not.toBeNull();

    // Action selectors — App.tsx pulls callbacks from the store; if any
    // of these are undefined at first paint, React errors with
    // "is not a function" the moment the user touches the UI.
    expect(typeof s.selectSession).toBe('function');
    expect(typeof s.focusGroup).toBe('function');
    expect(typeof s._applyExternalTitle).toBe('function');
    expect(typeof s._applyCwdRedirect).toBe('function');
    expect(typeof s._applyPtyExit).toBe('function');
    expect(typeof s.moveSession).toBe('function');
    expect(typeof s.createSession).toBe('function');

    // Hydration lifecycle: must start false so the AppSkeleton branch
    // takes effect (otherwise users with persisted sessions see a flash
    // of the empty CTA before the snapshot lands — see App.tsx:73-81
    // long-form comment).
    expect(s.hydrated).toBe(false);
  });
});
