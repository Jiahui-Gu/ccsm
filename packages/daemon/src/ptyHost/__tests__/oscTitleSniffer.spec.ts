// UTs for the phase B notify producer (Task #688). Pins the OSC 0 escape
// scanner contract: BEL/ST terminators, multi-OSC chunks, split-across-
// chunk escapes, per-sid isolation, clear() semantics, and bounded-buffer
// behaviour for hostile streams.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { OscTitleSniffer, type OscTitleEvent } from '../oscTitleSniffer.js';

function collect(sniffer: OscTitleSniffer): OscTitleEvent[] {
  const events: OscTitleEvent[] = [];
  sniffer.on('osc-title', (e: OscTitleEvent) => events.push(e));
  return events;
}

describe('OscTitleSniffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-29T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits on a single OSC 0 BEL-terminated escape', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]0;hello\x07');
    expect(events).toEqual([
      { sid: 'sid-1', title: 'hello', ts: Date.now() },
    ]);
  });

  it('emits on a single OSC 0 ST-terminated escape', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]0;hi\x1b\\');
    expect(events).toEqual([
      { sid: 'sid-1', title: 'hi', ts: Date.now() },
    ]);
  });

  it('emits multiple OSC sequences from a single chunk in order', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]0;a\x07text\x1b]0;b\x07');
    expect(events.map((e) => e.title)).toEqual(['a', 'b']);
    expect(events.every((e) => e.sid === 'sid-1')).toBe(true);
  });

  it('handles an OSC escape split across two chunks (one emit only)', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', 'partial \x1b]0;wai');
    expect(events).toHaveLength(0);
    s.feed('sid-1', 'ting\x07');
    expect(events).toEqual([
      { sid: 'sid-1', title: 'waiting', ts: Date.now() },
    ]);
  });

  it('keeps per-sid buffers isolated', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);

    s.feed('sid-A', 'noise \x1b]0;par'); // partial on A
    s.feed('sid-B', '\x1b]0;done\x07'); // complete on B

    expect(events).toEqual([
      { sid: 'sid-B', title: 'done', ts: Date.now() },
    ]);

    s.feed('sid-A', 'tial\x07'); // finish A
    expect(events).toEqual([
      { sid: 'sid-B', title: 'done', ts: Date.now() },
      { sid: 'sid-A', title: 'partial', ts: Date.now() },
    ]);
  });

  it('does not emit on plain text chunks with no OSC', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', 'hello world\nno escapes here at all\n');
    expect(events).toHaveLength(0);
  });

  it('clear(sid) drops any pending partial buffer', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);

    s.feed('sid-1', '\x1b]0;will-be-dropped'); // partial
    s.clear('sid-1');

    // Feeding the would-be terminator alone should not produce an emit
    // because the prefix is gone.
    s.feed('sid-1', '\x07');
    expect(events).toHaveLength(0);

    // And the sniffer should still work for a fresh OSC.
    s.feed('sid-1', '\x1b]0;fresh\x07');
    expect(events).toEqual([
      { sid: 'sid-1', title: 'fresh', ts: Date.now() },
    ]);
  });

  it('caps buffer growth on long OSC-free streams', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);

    const noise = 'x'.repeat(100 * 1024); // 100 KiB, no OSC
    s.feed('sid-1', noise);

    expect(events).toHaveLength(0);
    // Internal map: tail must be at most a few bytes (we keep up to 3 to
    // span a possible split escape prefix) — definitely << input.
    const internal = (s as unknown as { buffers: Map<string, string> }).buffers;
    const tail = internal.get('sid-1') ?? '';
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail.length).toBeLessThan(noise.length);

    // And a follow-up OSC still parses.
    s.feed('sid-1', '\x1b]0;ok\x07');
    expect(events).toEqual([{ sid: 'sid-1', title: 'ok', ts: Date.now() }]);
  });

  it('caps buffer growth on a never-terminated OSC', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);

    // Open OSC, then 100 KiB of title bytes with no terminator.
    s.feed('sid-1', '\x1b]0;' + 'A'.repeat(100 * 1024));
    expect(events).toHaveLength(0);

    const internal = (s as unknown as { buffers: Map<string, string> }).buffers;
    const tail = internal.get('sid-1') ?? '';
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('stamps ts from Date.now() on each emit', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);

    vi.setSystemTime(new Date('2026-04-29T12:00:00Z'));
    const t1 = Date.now();
    s.feed('sid-1', '\x1b]0;first\x07');

    vi.setSystemTime(new Date('2026-04-29T12:00:05Z'));
    const t2 = Date.now();
    s.feed('sid-1', '\x1b]0;second\x07');

    expect(events).toEqual([
      { sid: 'sid-1', title: 'first', ts: t1 },
      { sid: 'sid-1', title: 'second', ts: t2 },
    ]);
    expect(t2).toBeGreaterThan(t1);
  });

  it('ignores empty/null chunks safely', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', '');
    s.feed('sid-1', Buffer.alloc(0));
    expect(events).toHaveLength(0);
  });

  it('accepts Buffer input', () => {
    const s = new OscTitleSniffer();
    const events = collect(s);
    s.feed('sid-1', Buffer.from('\x1b]0;buf\x07', 'utf8'));
    expect(events).toEqual([{ sid: 'sid-1', title: 'buf', ts: Date.now() }]);
  });

  // OSC 2 (window-title) coverage — Task #713 merged the inlined
  // Osc2InlineSniffer (formerly in notify/sinks/pipeline.ts) into this
  // single dual-mode producer.
  describe('OSC 2 (window title)', () => {
    it('emits on a single OSC 2 BEL-terminated escape', () => {
      const s = new OscTitleSniffer();
      const events = collect(s);
      s.feed('sid-1', '\x1b]2;hello\x07');
      expect(events).toEqual([
        { sid: 'sid-1', title: 'hello', ts: Date.now() },
      ]);
    });

    it('emits on a single OSC 2 ST-terminated escape', () => {
      const s = new OscTitleSniffer();
      const events = collect(s);
      s.feed('sid-1', '\x1b]2;hi\x1b\\');
      expect(events).toEqual([
        { sid: 'sid-1', title: 'hi', ts: Date.now() },
      ]);
    });

    it('handles an OSC 2 escape split across two chunks', () => {
      const s = new OscTitleSniffer();
      const events = collect(s);
      s.feed('sid-1', 'noise \x1b]2;wai');
      expect(events).toHaveLength(0);
      s.feed('sid-1', 'ting\x07');
      expect(events).toEqual([
        { sid: 'sid-1', title: 'waiting', ts: Date.now() },
      ]);
    });

    it('handles a stream mixing OSC 0 and OSC 2 in any order', () => {
      const s = new OscTitleSniffer();
      const events = collect(s);
      s.feed(
        'sid-1',
        '\x1b]0;first\x07pad\x1b]2;second\x07more\x1b]0;third\x1b\\tail\x1b]2;fourth\x1b\\',
      );
      expect(events.map((e) => e.title)).toEqual([
        'first',
        'second',
        'third',
        'fourth',
      ]);
    });

    it('handles a partial OSC 2 prefix split across chunks (\\x1b]2 then ;...)', () => {
      const s = new OscTitleSniffer();
      const events = collect(s);
      s.feed('sid-1', 'pre\x1b]2');
      expect(events).toHaveLength(0);
      s.feed('sid-1', ';title\x07');
      expect(events).toEqual([
        { sid: 'sid-1', title: 'title', ts: Date.now() },
      ]);
    });
  });
});
