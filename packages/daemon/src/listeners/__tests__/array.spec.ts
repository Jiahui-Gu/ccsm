// Spec for the 2-slot listener tuple + sentinel + startup assert.
// Covers spec ch03 §1 (Listener trait shape + slot 1 invariant).

import { describe, expect, it } from 'vitest';
import {
  RESERVED_FOR_LISTENER_B,
  assertSlot1Reserved,
  type ListenerSlots,
} from '../array.js';
import type { BindDescriptor, Listener } from '../types.js';

function makeFakeListener(id: string): Listener {
  let started = false;
  return {
    id,
    async start() {
      started = true;
    },
    async stop() {
      started = false;
    },
    descriptor(): BindDescriptor {
      if (!started) {
        throw new Error('descriptor() called before start()');
      }
      return { kind: 'uds', path: `/tmp/${id}.sock` };
    },
  };
}

describe('RESERVED_FOR_LISTENER_B sentinel', () => {
  it('is a Symbol with the canonical registry key', () => {
    expect(typeof RESERVED_FOR_LISTENER_B).toBe('symbol');
    expect(RESERVED_FOR_LISTENER_B).toBe(Symbol.for('ccsm.listener.reserved-b'));
  });

  it('is reference-equal across imports (single source of truth)', async () => {
    const fromArray = (await import('../array.js')).RESERVED_FOR_LISTENER_B;
    const fromTypes = (await import('../types.js')).RESERVED_FOR_LISTENER_B;
    const fromEnv = (await import('../../env.js')).RESERVED_FOR_LISTENER_B;
    expect(fromArray).toBe(RESERVED_FOR_LISTENER_B);
    expect(fromTypes).toBe(RESERVED_FOR_LISTENER_B);
    expect(fromEnv).toBe(RESERVED_FOR_LISTENER_B);
  });
});

describe('ListenerSlots tuple shape', () => {
  it('accepts a real Listener at slot 0 and the sentinel at slot 1', () => {
    const a = makeFakeListener('listener-a');
    const slots: ListenerSlots = [a, RESERVED_FOR_LISTENER_B];
    expect(slots).toHaveLength(2);
    expect(slots[0]).toBe(a);
    expect(slots[1]).toBe(RESERVED_FOR_LISTENER_B);
  });
});

describe('assertSlot1Reserved', () => {
  it('passes when slot 1 is the sentinel (happy path)', () => {
    const a = makeFakeListener('listener-a');
    const slots: readonly [unknown, unknown] = [a, RESERVED_FOR_LISTENER_B];
    expect(() => assertSlot1Reserved(slots)).not.toThrow();
  });

  it('throws when slot 1 has been swapped to a real listener (failure path)', () => {
    const a = makeFakeListener('listener-a');
    const b = makeFakeListener('listener-b');
    const slots: readonly [unknown, unknown] = [a, b];
    expect(() => assertSlot1Reserved(slots)).toThrow(
      /listeners\[1\] is not RESERVED_FOR_LISTENER_B/,
    );
  });

  it('throws when slot 1 is null / undefined / a stray symbol', () => {
    const a = makeFakeListener('listener-a');
    expect(() => assertSlot1Reserved([a, null])).toThrow();
    expect(() => assertSlot1Reserved([a, undefined])).toThrow();
    expect(() => assertSlot1Reserved([a, Symbol.for('ccsm.listener.reserved-b.OOPS')])).toThrow();
  });
});
