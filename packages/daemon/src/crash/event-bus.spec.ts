// Unit tests for the in-memory CrashEventBus (#340 / Wave 3 §6.9).
//
// Covers:
//   - emit fans out to every registered listener.
//   - unsubscribe removes the listener and is idempotent.
//   - multiple listeners observe the same event (no fan-out drops).
//   - listener exception isolation (a throwing listener does not break
//     fanout to its peers; the error is reported through onListenerError).
//   - snapshot iteration: a listener that unsubscribes itself during
//     dispatch does not skip its peers.
//   - module-level `defaultCrashEventBus` is the singleton the
//     raw-appender hook emits on (smoke check).
//
// Spec refs: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (#228 audit) — bus is the event source for the future #335
// CrashService.WatchCrashLog handler.

import { describe, expect, it, vi } from 'vitest';

import { CrashEventBus, defaultCrashEventBus } from './event-bus.js';
import type { CrashRawEntry } from './raw-appender.js';
import { appendCrashRaw } from './raw-appender.js';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function makeEntry(id: string, source = 'uncaughtException'): CrashRawEntry {
  return {
    id,
    ts_ms: 1_700_000_000_000,
    source,
    summary: `${source} test`,
    detail: 'detail',
    labels: { errorName: 'TestError' },
    owner_id: 'daemon-self',
  };
}

describe('CrashEventBus', () => {
  it('emitCrashAdded fans out to a single subscriber', () => {
    const bus = new CrashEventBus();
    const listener = vi.fn();
    bus.onCrashAdded(listener);

    const entry = makeEntry('id-1');
    bus.emitCrashAdded(entry);

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]?.[0]).toBe(entry);
  });

  it('delivers each event to every registered listener (fan-out)', () => {
    const bus = new CrashEventBus();
    const a = vi.fn();
    const b = vi.fn();
    const c = vi.fn();
    bus.onCrashAdded(a);
    bus.onCrashAdded(b);
    bus.onCrashAdded(c);

    bus.emitCrashAdded(makeEntry('id-1'));
    bus.emitCrashAdded(makeEntry('id-2', 'sqlite_op'));

    expect(a).toHaveBeenCalledTimes(2);
    expect(b).toHaveBeenCalledTimes(2);
    expect(c).toHaveBeenCalledTimes(2);
    expect(a.mock.calls[0]?.[0].id).toBe('id-1');
    expect(a.mock.calls[1]?.[0].id).toBe('id-2');
  });

  it('unsubscribe removes the listener and is idempotent', () => {
    const bus = new CrashEventBus();
    const listener = vi.fn();
    const unsub = bus.onCrashAdded(listener);

    expect(bus.listenerCount()).toBe(1);
    unsub();
    expect(bus.listenerCount()).toBe(0);
    // second call must be a no-op
    expect(() => unsub()).not.toThrow();
    expect(bus.listenerCount()).toBe(0);

    bus.emitCrashAdded(makeEntry('id-1'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('unsubscribing one listener does not affect others', () => {
    const bus = new CrashEventBus();
    const survivor = vi.fn();
    const leaver = vi.fn();
    const unsubLeaver = bus.onCrashAdded(leaver);
    bus.onCrashAdded(survivor);

    unsubLeaver();
    bus.emitCrashAdded(makeEntry('id-1'));

    expect(leaver).not.toHaveBeenCalled();
    expect(survivor).toHaveBeenCalledTimes(1);
  });

  it('isolates listener exceptions: one throwing listener does not block its peers', () => {
    const errors: unknown[] = [];
    const bus = new CrashEventBus({
      onListenerError: (err) => errors.push(err),
    });
    const thrower = vi.fn(() => {
      throw new Error('boom');
    });
    const survivor = vi.fn();
    bus.onCrashAdded(thrower);
    bus.onCrashAdded(survivor);

    bus.emitCrashAdded(makeEntry('id-1'));

    expect(thrower).toHaveBeenCalledTimes(1);
    expect(survivor).toHaveBeenCalledTimes(1);
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('boom');
  });

  it('snapshot iteration: a listener that unsubscribes during dispatch does not skip its peers', () => {
    const bus = new CrashEventBus();
    const calls: string[] = [];

    let unsubA: () => void = () => {};
    const a = vi.fn(() => {
      calls.push('a');
      unsubA();
    });
    const b = vi.fn(() => calls.push('b'));
    unsubA = bus.onCrashAdded(a);
    bus.onCrashAdded(b);

    bus.emitCrashAdded(makeEntry('id-1'));

    expect(calls).toEqual(['a', 'b']);
    expect(bus.listenerCount()).toBe(1);
  });

  it('emit with no subscribers is a no-op', () => {
    const bus = new CrashEventBus();
    expect(() => bus.emitCrashAdded(makeEntry('id-1'))).not.toThrow();
  });

  it('exports a module-level defaultCrashEventBus singleton usable for direct subscription', () => {
    // Smoke check — the raw-appender hook emits on this exact instance.
    // We subscribe + emit + unsubscribe to keep the singleton clean for
    // any sibling test that touches it.
    const listener = vi.fn();
    const unsub = defaultCrashEventBus.onCrashAdded(listener);
    try {
      defaultCrashEventBus.emitCrashAdded(makeEntry('id-default'));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      unsub();
    }
    expect(defaultCrashEventBus.listenerCount()).toBe(0);
  });

  it('appendCrashRaw emits on defaultCrashEventBus AFTER the entry is durable on disk', () => {
    // Wire-up test: prove the single emit hook in raw-appender.ts fires
    // on the same singleton consumers will subscribe to. Without this,
    // the hook could silently regress (e.g. someone bypasses the bus on
    // a refactor) and #335's WatchCrashLog handler would deliver
    // nothing — but unit tests that mock the bus would still pass.
    const dir = mkdtempSync(join(tmpdir(), 'ccsm-crash-bus-'));
    const path = join(dir, 'crash-raw.ndjson');
    const observed: CrashRawEntry[] = [];
    const unsub = defaultCrashEventBus.onCrashAdded((entry) => {
      observed.push(entry);
      // Emit happens AFTER fsync/close — the file must already contain
      // the line by the time we observe the event.
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(entry.id);
    });
    try {
      const entry = makeEntry('wire-up-1');
      appendCrashRaw(path, entry);
      expect(observed).toHaveLength(1);
      expect(observed[0]).toBe(entry);
    } finally {
      unsub();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
