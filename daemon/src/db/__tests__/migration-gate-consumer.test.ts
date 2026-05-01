import { describe, expect, it, vi } from 'vitest';
import { MigrationGateConsumer, type MigrationState } from '../migration-gate-consumer.js';

describe('MigrationGateConsumer (T35 — frag-8 §8.5/§8.6)', () => {
  describe('initial state', () => {
    it('starts in idle', () => {
      const c = new MigrationGateConsumer();
      expect(c.getMigrationState()).toBe<MigrationState>('idle');
    });

    it('reports not pending in idle (T10 fast path)', () => {
      const c = new MigrationGateConsumer();
      expect(c.isMigrationPending()).toBe(false);
    });
  });

  describe('isMigrationPending() boolean projection (T10 contract)', () => {
    it.each<[MigrationState, boolean]>([
      ['idle', false],
      ['pending', true],
      ['completed', false],
      ['failed', true],
    ])('state=%s → isMigrationPending()=%s', (state, expected) => {
      const c = new MigrationGateConsumer();
      c.setMigrationState(state);
      expect(c.isMigrationPending()).toBe(expected);
    });
  });

  describe('setMigrationState transitions (spec §8.5)', () => {
    it('idle → pending notifies subscribers with new state', () => {
      const c = new MigrationGateConsumer();
      const listener = vi.fn();
      c.subscribe(listener);
      c.setMigrationState('pending');
      expect(c.getMigrationState()).toBe('pending');
      expect(listener).toHaveBeenCalledWith('pending');
      expect(listener).toHaveBeenCalledTimes(1);
    });

    it('pending → completed flips isMigrationPending() back to false', () => {
      const c = new MigrationGateConsumer();
      c.setMigrationState('pending');
      expect(c.isMigrationPending()).toBe(true);
      c.setMigrationState('completed');
      expect(c.isMigrationPending()).toBe(false);
    });

    it('pending → failed keeps isMigrationPending() true (modal still blocks)', () => {
      const c = new MigrationGateConsumer();
      c.setMigrationState('pending');
      c.setMigrationState('failed');
      expect(c.getMigrationState()).toBe('failed');
      expect(c.isMigrationPending()).toBe(true);
    });

    it('no-op when next state equals current state (no notification)', () => {
      const c = new MigrationGateConsumer();
      const listener = vi.fn();
      c.setMigrationState('pending');
      c.subscribe(listener);
      c.setMigrationState('pending'); // re-emit same value
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('subscribe / unsubscribe', () => {
    it('returns disposer that stops further notifications', () => {
      const c = new MigrationGateConsumer();
      const listener = vi.fn();
      const unsubscribe = c.subscribe(listener);
      c.setMigrationState('pending');
      unsubscribe();
      c.setMigrationState('completed');
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith('pending');
    });

    it('disposer is idempotent (double-unsubscribe is safe)', () => {
      const c = new MigrationGateConsumer();
      const listener = vi.fn();
      const unsubscribe = c.subscribe(listener);
      unsubscribe();
      unsubscribe();
      c.setMigrationState('pending');
      expect(listener).not.toHaveBeenCalled();
    });

    it('does not fire on subscribe (consumers must read getMigrationState)', () => {
      const c = new MigrationGateConsumer();
      c.setMigrationState('pending');
      const listener = vi.fn();
      c.subscribe(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies multiple subscribers in registration order', () => {
      const c = new MigrationGateConsumer();
      const calls: Array<[string, MigrationState]> = [];
      c.subscribe((s) => calls.push(['a', s]));
      c.subscribe((s) => calls.push(['b', s]));
      c.subscribe((s) => calls.push(['c', s]));
      c.setMigrationState('pending');
      expect(calls).toEqual([
        ['a', 'pending'],
        ['b', 'pending'],
        ['c', 'pending'],
      ]);
    });

    it('all subscribers see every transition', () => {
      const c = new MigrationGateConsumer();
      const a = vi.fn();
      const b = vi.fn();
      c.subscribe(a);
      c.subscribe(b);
      c.setMigrationState('pending');
      c.setMigrationState('completed');
      expect(a).toHaveBeenCalledTimes(2);
      expect(b).toHaveBeenCalledTimes(2);
      expect(a.mock.calls).toEqual([['pending'], ['completed']]);
      expect(b.mock.calls).toEqual([['pending'], ['completed']]);
    });

    it('unsubscribing one listener does not affect siblings', () => {
      const c = new MigrationGateConsumer();
      const a = vi.fn();
      const b = vi.fn();
      const unsubA = c.subscribe(a);
      c.subscribe(b);
      unsubA();
      c.setMigrationState('pending');
      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledWith('pending');
    });
  });

  describe('listener error isolation', () => {
    it('a throwing listener does not block siblings', async () => {
      const c = new MigrationGateConsumer();
      const sibling = vi.fn();
      // Capture the microtask-reraised error so vitest doesn't flag it
      // as an unhandled exception; we want to assert it surfaces *off*
      // the producer call stack, not that it disappears.
      const captured: unknown[] = [];
      const onUncaught = (err: unknown) => captured.push(err);
      process.once('uncaughtException', onUncaught);
      c.subscribe(() => {
        throw new Error('boom');
      });
      c.subscribe(sibling);
      // setState itself must not throw — error is reraised on a microtask.
      expect(() => c.setMigrationState('pending')).not.toThrow();
      expect(sibling).toHaveBeenCalledWith('pending');
      // Drain microtasks so the queueMicrotask rethrow lands.
      await new Promise<void>((r) => setImmediate(r));
      process.removeListener('uncaughtException', onUncaught);
      expect(captured).toHaveLength(1);
      expect((captured[0] as Error).message).toBe('boom');
    });

    it('unsubscribing inside a callback does not skip the next sibling', () => {
      const c = new MigrationGateConsumer();
      const sibling = vi.fn();
      const unsubSelf = c.subscribe(() => {
        unsubSelf();
      });
      c.subscribe(sibling);
      c.setMigrationState('pending');
      expect(sibling).toHaveBeenCalledWith('pending');
      // Self-unsubscribed listener is gone for the next transition.
      sibling.mockClear();
      c.setMigrationState('completed');
      expect(sibling).toHaveBeenCalledWith('completed');
    });
  });

  describe('clearSubscribersForTests', () => {
    it('drops all listeners', () => {
      const c = new MigrationGateConsumer();
      const a = vi.fn();
      const b = vi.fn();
      c.subscribe(a);
      c.subscribe(b);
      c.clearSubscribersForTests();
      c.setMigrationState('pending');
      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });
  });
});
