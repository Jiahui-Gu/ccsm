// Tests for streamHandleTable — pure registry, no I/O, no clock.
// Spec: frag-3.7 §3.7.5 step 1 (reconnect tears down stale handles).

import { describe, it, expect, vi } from 'vitest';
import { createStreamHandleTable } from '../streamHandleTable';

describe('createStreamHandleTable', () => {
  it('starts empty', () => {
    const table = createStreamHandleTable();
    expect(table.count()).toBe(0);
    expect(table.snapshot()).toEqual([]);
  });

  it('register adds an entry visible in snapshot + count', () => {
    const table = createStreamHandleTable();
    table.register({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      subId: 'sid-1',
      subscriberId: 'sub-A',
      openedAt: 100,
    });
    expect(table.count()).toBe(1);
    const snap = table.snapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0]).toMatchObject({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      subId: 'sid-1',
      subscriberId: 'sub-A',
      openedAt: 100,
    });
  });

  it('snapshot sorts by openedAt ascending', () => {
    const table = createStreamHandleTable();
    table.register({ handleId: 'late', streamType: 'data-stream', openedAt: 300 });
    table.register({ handleId: 'early', streamType: 'data-stream', openedAt: 100 });
    table.register({ handleId: 'mid', streamType: 'data-stream', openedAt: 200 });
    expect(table.snapshot().map((e) => e.handleId)).toEqual([
      'early',
      'mid',
      'late',
    ]);
  });

  it('snapshot entries are frozen and exclude cancel callback', () => {
    const table = createStreamHandleTable();
    table.register({
      handleId: 'h1',
      streamType: 'control-stream',
      openedAt: 100,
      cancel: () => {},
    });
    const entry = table.snapshot()[0] as Record<string, unknown>;
    expect(Object.isFrozen(entry)).toBe(true);
    expect(entry.cancel).toBeUndefined();
  });

  it('register returns RAII unregister', () => {
    const table = createStreamHandleTable();
    const reg = table.register({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      openedAt: 100,
    });
    expect(table.count()).toBe(1);
    reg.unregister();
    expect(table.count()).toBe(0);
  });

  it('double unregister is a no-op (idempotent)', () => {
    const table = createStreamHandleTable();
    const reg = table.register({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      openedAt: 100,
    });
    reg.unregister();
    expect(() => reg.unregister()).not.toThrow();
    expect(table.count()).toBe(0);
  });

  it('unregister(handleId) removes the entry', () => {
    const table = createStreamHandleTable();
    table.register({ handleId: 'h1', streamType: 'pty-subscribe', openedAt: 100 });
    table.register({ handleId: 'h2', streamType: 'pty-subscribe', openedAt: 200 });
    table.unregister('h1');
    expect(table.count()).toBe(1);
    expect(table.snapshot()[0].handleId).toBe('h2');
  });

  it('unregister of unknown id is a no-op', () => {
    const table = createStreamHandleTable();
    expect(() => table.unregister('ghost')).not.toThrow();
  });

  it('clear() empties the table without invoking cancel', () => {
    const table = createStreamHandleTable();
    const cancel = vi.fn();
    table.register({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      openedAt: 100,
      cancel,
    });
    table.clear();
    expect(table.count()).toBe(0);
    expect(cancel).not.toHaveBeenCalled();
  });

  it('cancelAll() invokes every cancel and empties the table', async () => {
    const table = createStreamHandleTable();
    const c1 = vi.fn();
    const c2 = vi.fn();
    table.register({ handleId: 'h1', streamType: 'pty-subscribe', openedAt: 100, cancel: c1 });
    table.register({ handleId: 'h2', streamType: 'control-stream', openedAt: 200, cancel: c2 });
    await table.cancelAll();
    expect(c1).toHaveBeenCalledTimes(1);
    expect(c2).toHaveBeenCalledTimes(1);
    expect(table.count()).toBe(0);
  });

  it('cancelAll() awaits async cancels', async () => {
    const table = createStreamHandleTable();
    let resolved = false;
    table.register({
      handleId: 'h1',
      streamType: 'data-stream',
      openedAt: 100,
      cancel: async () => {
        await new Promise((r) => setTimeout(r, 5));
        resolved = true;
      },
    });
    await table.cancelAll();
    expect(resolved).toBe(true);
  });

  it('cancelAll() swallows errors so one bad handle does not strand others', async () => {
    const table = createStreamHandleTable();
    const good = vi.fn();
    table.register({
      handleId: 'bad',
      streamType: 'pty-subscribe',
      openedAt: 100,
      cancel: () => {
        throw new Error('boom');
      },
    });
    table.register({
      handleId: 'good',
      streamType: 'pty-subscribe',
      openedAt: 200,
      cancel: good,
    });
    await expect(table.cancelAll()).resolves.toBeUndefined();
    expect(good).toHaveBeenCalledTimes(1);
    expect(table.count()).toBe(0);
  });

  it('cancelAll() with no handles resolves cleanly', async () => {
    const table = createStreamHandleTable();
    await expect(table.cancelAll()).resolves.toBeUndefined();
  });

  it('register with duplicate handleId replaces the prior entry; old RAII is inert', () => {
    const table = createStreamHandleTable();
    const oldReg = table.register({
      handleId: 'h1',
      streamType: 'pty-subscribe',
      openedAt: 100,
    });
    table.register({
      handleId: 'h1',
      streamType: 'control-stream',
      openedAt: 200,
    });
    // Old RAII must NOT remove the new entry.
    oldReg.unregister();
    expect(table.count()).toBe(1);
    expect(table.snapshot()[0]).toMatchObject({
      handleId: 'h1',
      streamType: 'control-stream',
      openedAt: 200,
    });
  });

  it('factory returns independent instances', () => {
    const a = createStreamHandleTable();
    const b = createStreamHandleTable();
    a.register({ handleId: 'h1', streamType: 'pty-subscribe', openedAt: 100 });
    expect(a.count()).toBe(1);
    expect(b.count()).toBe(0);
  });
});
