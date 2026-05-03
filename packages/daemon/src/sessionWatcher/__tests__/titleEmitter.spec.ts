// Unit tests for TitleEmitterSink in isolation (no fs.watch, no SDK).
//
// The sink is given an injected TitleFetcher so we can drive every branch
// of the decideTitleEmit gate (null / empty / new / duplicate) without
// touching the title bridge or fs.

import { describe, it, expect, vi } from 'vitest';
import { TitleEmitterSink, type TitleChangedPayload, type TitleFetcher } from '../titleEmitter.js';
import type { FileTick } from '../fileSource.js';

function presentTick(sid: string): FileTick {
  return { sid, text: '{"type":"user"}\n', fileExists: true, ts: Date.now() };
}

function missingTick(sid: string): FileTick {
  return { sid, text: '', fileExists: false, ts: Date.now() };
}

function flush(): Promise<void> {
  // Two microtask flushes: maybeEmit awaits fetchTitle then emits.
  return new Promise((r) => setImmediate(r));
}

describe('TitleEmitterSink', () => {
  it('skips ticks where fileExists is false', async () => {
    const events: TitleChangedPayload[] = [];
    const fetcher = vi.fn(async () => ({ summary: 'should not be queried' }));
    const sink = new TitleEmitterSink((p) => events.push(p), fetcher);
    sink.onTick(missingTick('s1'));
    await flush();
    expect(fetcher).not.toHaveBeenCalled();
    expect(events).toHaveLength(0);
  });

  it('emits once for a fresh non-empty summary', async () => {
    const events: TitleChangedPayload[] = [];
    const fetcher: TitleFetcher = async () => ({ summary: 'first title' });
    const sink = new TitleEmitterSink((p) => events.push(p), fetcher);
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toEqual([{ sid: 's1', title: 'first title' }]);
  });

  it('does not emit when fetcher returns null summary', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => ({ summary: null }),
    );
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toHaveLength(0);
  });

  it('does not emit when fetcher returns empty string summary', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => ({ summary: '' }),
    );
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toHaveLength(0);
  });

  it('dedupes identical titles via lastEmittedTitle', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => ({ summary: 'same' }),
    );
    sink.onTick(presentTick('s1'));
    await flush();
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toHaveLength(1);
  });

  it('emits again when summary changes', async () => {
    const events: TitleChangedPayload[] = [];
    const summaries = ['v1', 'v2'];
    const fetcher: TitleFetcher = async () => ({ summary: summaries.shift() ?? null });
    const sink = new TitleEmitterSink((p) => events.push(p), fetcher);
    sink.onTick(presentTick('s1'));
    await flush();
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events.map((e) => e.title)).toEqual(['v1', 'v2']);
  });

  it('swallows fetcher errors without emitting', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => {
        throw new Error('boom');
      },
    );
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toHaveLength(0);
    // Subsequent successful ticks still work (no permanent broken state).
    sink.setFetcher(async () => ({ summary: 'recovered' }));
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toEqual([{ sid: 's1', title: 'recovered' }]);
  });

  it('does not emit after forget(sid) even if a pending fetch resolves', async () => {
    const events: TitleChangedPayload[] = [];
    let resolveFetch!: (v: { summary: string }) => void;
    const pending = new Promise<{ summary: string }>((res) => {
      resolveFetch = res;
    });
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      () => pending,
    );
    sink.onTick(presentTick('s1'));
    sink.forget('s1');
    resolveFetch({ summary: 'late' });
    await flush();
    expect(events).toHaveLength(0);
  });

  it('forget then re-watch starts with a fresh lastEmittedTitle', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => ({ summary: 'T' }),
    );
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events).toHaveLength(1);
    sink.forget('s1');
    sink.onTick(presentTick('s1'));
    await flush();
    // After forget, the next identical title is a "fresh" emit.
    expect(events).toHaveLength(2);
  });

  it('passes cwd through to the fetcher', async () => {
    const fetcher = vi.fn(async () => ({ summary: 'x' }));
    const sink = new TitleEmitterSink(vi.fn(function () { return undefined; }), fetcher);
    sink.onTick(presentTick('s1'), '/some/cwd');
    await flush();
    expect(fetcher).toHaveBeenCalledWith('s1', '/some/cwd');
  });

  it('setFetcher swaps the fetcher for subsequent ticks', async () => {
    const events: TitleChangedPayload[] = [];
    const sink = new TitleEmitterSink(
      (p) => events.push(p),
      async () => ({ summary: 'old' }),
    );
    sink.onTick(presentTick('s1'));
    await flush();
    sink.setFetcher(async () => ({ summary: 'new' }));
    sink.onTick(presentTick('s1'));
    await flush();
    expect(events.map((e) => e.title)).toEqual(['old', 'new']);
  });
});
