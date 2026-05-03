// Runtime + type-level backstop for the closed 2-slot Listener tuple.
// Spec ch15 §3 forbidden-pattern #6 (no listener-tuple growth) + #18
// (typed sentinel pinned in slot 1 until v0.4 Listener B lands).
//
// Why this file exists alongside `array.spec.ts` and the merged
// `shape-no-growth.spec.ts` (PR #906):
//   - `array.spec.ts` exercises the `ListenerSlots` type + sentinel
//     identity in isolation (synthetic tuples).
//   - `shape-no-growth.spec.ts` is a SOURCE-TEXT scan of `index.ts`
//     that catches mutating method names (push/pop/splice/...) at
//     pre-commit time without instantiating the daemon.
//   - THIS file is the RUNTIME + TYPE-LEVEL backstop: it builds a real
//     `DaemonEnv` via `buildDaemonEnv()` and asserts the tuple shape
//     after boot, AND uses `// @ts-expect-error` to prove tsc itself
//     rejects `.push()` on the readonly tuple type.
//
// Three layers (compile-time / lint-time / runtime) by design — see
// the comment block atop `array.ts` and `eslint-plugins/ccsm-no-
// listener-slot-mutation.js`. This spec is the third leg.
//
// SRP: this module is a test (decider over the runtime shape). No I/O
// beyond `buildDaemonEnv()`, which only reads process.env.
//
// Note on the type-level checks below: TypeScript `readonly`/tuple
// constraints are purely compile-time — they do NOT freeze the array
// at runtime. We therefore park every `@ts-expect-error` line inside a
// function that is declared but NEVER CALLED, so tsc still typechecks
// the body (and reports TS2578 "unused @ts-expect-error" if any line
// would in fact compile cleanly), but vitest does not execute the
// mutation. The runtime-shape `describe` block above stands on its own.

import { describe, expect, it } from 'vitest';
import { buildDaemonEnv, RESERVED_FOR_LISTENER_B } from '../../env.js';

describe('DaemonEnv.listeners closed 2-slot tuple (spec ch15 §3 #6 + #18)', () => {
  it('has length === 2 after buildDaemonEnv()', () => {
    const env = buildDaemonEnv();
    expect(env.listeners).toHaveLength(2);
    expect(env.listeners.length).toBe(2);
  });

  it('pins slot 1 to RESERVED_FOR_LISTENER_B (identity, not just equality)', () => {
    const env = buildDaemonEnv();
    expect(env.listeners[1]).toBe(RESERVED_FOR_LISTENER_B);
    // Sanity: the sentinel resolves to the canonical Symbol.for key
    // (a typo in the env-side declaration would break the v0.4 swap).
    expect(env.listeners[1]).toBe(Symbol.for('ccsm.listener.reserved-b'));
  });

  it('keeps slot 0 / slot 1 stable across repeated buildDaemonEnv() calls', () => {
    // The sentinel is module-scope; rebuilding env must not mint a fresh
    // symbol or rewrite the slot-1 reference. v0.4 Listener B replaces
    // slot 1 in EXACTLY one place (the spec-blessed makeListenerB call);
    // any other rewrite is a Layer 1 violation.
    const a = buildDaemonEnv();
    const b = buildDaemonEnv();
    expect(a.listeners[1]).toBe(b.listeners[1]);
    expect(a.listeners).toHaveLength(b.listeners.length);
  });
});

// -----------------------------------------------------------------
// Type-level backstop — tsc must reject every mutation below.
// -----------------------------------------------------------------
//
// This function is intentionally never called. tsc still typechecks
// its body when the file is part of the daemon `tsconfig` include set
// (it is — `src/**/*` covers `__tests__`). Each `@ts-expect-error`
// line here MUST suppress a real TS error; if the readonly tuple
// constraint is ever weakened, tsc emits TS2578 ("Unused
// '@ts-expect-error' directive") and the typecheck step fails.
//
// vitest does NOT run this function (it is not wrapped in `it`/`test`),
// so the runtime mutation never fires. This sidesteps the fact that
// TypeScript's `readonly` tuple is a compile-time-only constraint.
//
// Do NOT delete this function; do NOT call it. Reviewers: if you see
// a PR removing the export-or-keep-alive trick below, reject it.
function _typeOnly_listenerTupleIsReadonly(): void {
  const env = buildDaemonEnv();

  // The ccsm/no-listener-slot-mutation ESLint rule (T1.9) ALSO fires on
  // every line below — that is the lint-time guard doing its job. We
  // intentionally bypass it here because (a) this function is never
  // called at runtime, and (b) the whole point of these lines is to
  // make tsc reject them. The eslint-disable is the test seam, not a
  // real escape hatch — keep it limited to this single function body.
  /* eslint-disable ccsm/no-listener-slot-mutation */

  // Compile-time: every mutating method on the readonly tuple is rejected.
  // @ts-expect-error — readonly tuple has no .push().
  env.listeners.push(null);
  // @ts-expect-error — readonly tuple has no .pop().
  env.listeners.pop();
  // @ts-expect-error — readonly tuple has no .shift().
  env.listeners.shift();
  // @ts-expect-error — readonly tuple has no .unshift().
  env.listeners.unshift(null);
  // @ts-expect-error — readonly tuple has no .splice().
  env.listeners.splice(0, 1);
  // @ts-expect-error — readonly tuple has no .sort().
  env.listeners.sort();
  // @ts-expect-error — readonly tuple has no .reverse().
  env.listeners.reverse();
  // @ts-expect-error — readonly tuple has no .fill().
  env.listeners.fill(null);
  // @ts-expect-error — readonly tuple has no .copyWithin().
  env.listeners.copyWithin(0, 1);

  // Compile-time: slot-1 reassignment is rejected (slot is typed
  // `ReservedForListenerB`, no other value is assignable).
  // @ts-expect-error — slot 1 is `ReservedForListenerB`; null is not assignable.
  env.listeners[1] = null;

  /* eslint-enable ccsm/no-listener-slot-mutation */
}

// Keep tsc from pruning the function as dead code via re-export.
// This is a no-op at runtime (the export is never imported) but it
// guarantees the body remains in the typecheck graph.
export const __typeOnlyListenerTupleProbe = _typeOnly_listenerTupleIsReadonly;
