// 2-slot listener tuple + startup assert — spec ch03 §1.
//
// v0.3 ships exactly one active listener (Listener A); slot 1 is pinned
// to the typed sentinel `RESERVED_FOR_LISTENER_B` so v0.4 can swap in
// `makeListenerB(env)` without rippling shape changes through every
// caller. The closed 2-tuple shape is enforced statically by
// `ListenerSlots`; the runtime assert (`assertSlot1Reserved`) is the
// gate the entrypoint calls during phase STARTING_LISTENERS to refuse
// boot if anything snuck a real listener into slot 1 before v0.4.
//
// SRP: this module is the slot-shape decider. No I/O, no factories.
// The Listener A factory lives in T1.4; the no-mutation ESLint rule
// lives in T1.9.

import { RESERVED_FOR_LISTENER_B, type ReservedForListenerB, type Listener } from './types.js';

/**
 * The exact shape of `DaemonEnv.listeners` once T1.4 lands. Slot 0 is a
 * real Listener; slot 1 stays as the typed sentinel until v0.4.
 */
export type ListenerSlots = readonly [Listener, Listener | ReservedForListenerB];

/**
 * Startup assert — throws if slot 1 has been swapped away from the
 * `RESERVED_FOR_LISTENER_B` sentinel. Called from the entrypoint during
 * phase STARTING_LISTENERS so any v0.4-style two-listener boot fails
 * fast with a clear message instead of silently activating Listener B
 * before its v0.4 spec lands.
 *
 * NOTE: this is a runtime backstop. The compile-time guard is the
 * `ListenerSlots` tuple shape; the lint-time guard is T1.9's
 * `no-listener-slot-mutation` rule. All three layers exist by design.
 */
export function assertSlot1Reserved(
  slots: readonly [unknown, unknown],
): asserts slots is readonly [unknown, ReservedForListenerB] {
  if (slots[1] !== RESERVED_FOR_LISTENER_B) {
    throw new Error(
      'listeners[1] is not RESERVED_FOR_LISTENER_B — Listener B activation is a v0.4 change (spec ch03 §1).',
    );
  }
}

export { RESERVED_FOR_LISTENER_B, type ReservedForListenerB } from './types.js';
