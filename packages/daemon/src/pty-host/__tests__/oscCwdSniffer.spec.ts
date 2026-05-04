// UTs for the OSC 7 cwd sniffer (T5.8 / Task #66). Pins the OSC 7 escape
// scanner contract: BEL/ST terminators, multi-OSC chunks, split-across-chunk
// escapes, per-sid isolation, clear() semantics, percent-decoding,
// Windows path normalization, and bounded-buffer behaviour for hostile
// streams.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  OscCwdSniffer,
  parseOsc7Body,
  type OscCwdEvent,
} from '../oscCwdSniffer.js';

function collect(sniffer: OscCwdSniffer): OscCwdEvent[] {
  const events: OscCwdEvent[] = [];
  sniffer.on('osc-cwd', (e: OscCwdEvent) => events.push(e));
  return events;
}

describe('parseOsc7Body', () => {
  it('parses a POSIX file:// URI with empty host', () => {
    expect(parseOsc7Body('file:///tmp/foo')).toBe('/tmp/foo');
  });

  it('parses a POSIX file:// URI with literal hostname', () => {
    expect(parseOsc7Body('file://my-host/tmp/foo')).toBe('/tmp/foo');
  });

  it('percent-decodes the path', () => {
    expect(parseOsc7Body('file:///tmp/with%20space')).toBe('/tmp/with space');
    expect(parseOsc7Body('file:///%E4%B8%AD%E6%96%87')).toBe('/中文');
  });

  it('strips the leading slash on Windows-style drive paths', () => {
    expect(parseOsc7Body('file:///C:/Users/foo')).toBe('C:/Users/foo');
    expect(parseOsc7Body('file://host/D:/work')).toBe('D:/work');
  });

  it('keeps POSIX leading slash', () => {
    expect(parseOsc7Body('file:///')).toBe('/');
    expect(parseOsc7Body('file:///a')).toBe('/a');
  });

  it('returns null for non-file:// schemes', () => {
    expect(parseOsc7Body('http://example.com/foo')).toBeNull();
    expect(parseOsc7Body('/tmp/raw')).toBeNull();
    expect(parseOsc7Body('')).toBeNull();
  });

  it('returns null for malformed file:// URIs (no path slash after host)', () => {
    expect(parseOsc7Body('file://host')).toBeNull();
    expect(parseOsc7Body('file://')).toBeNull();
  });

  it('returns null for malformed percent-encoding', () => {
    expect(parseOsc7Body('file:///bad/%ZZ')).toBeNull();
  });
});

describe('OscCwdSniffer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-04T00:00:00Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('emits on a single OSC 7 BEL-terminated escape', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;file:///tmp/foo\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/tmp/foo', ts: Date.now() },
    ]);
  });

  it('emits on a single OSC 7 ST-terminated escape', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;file:///tmp/bar\x1b\\');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/tmp/bar', ts: Date.now() },
    ]);
  });

  it('emits with a literal host segment in the URI', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;file://localhost/var/tmp\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/var/tmp', ts: Date.now() },
    ]);
  });

  it('emits multiple OSC 7 sequences from a single chunk in order', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed(
      'sid-1',
      '\x1b]7;file:///a\x07prompt$\x1b]7;file:///b\x07',
    );
    expect(events.map((e) => e.cwd)).toEqual(['/a', '/b']);
    expect(events.every((e) => e.sid === 'sid-1')).toBe(true);
  });

  it('handles an OSC escape split across two chunks (one emit only)', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', 'noise \x1b]7;file:///tm');
    expect(events).toHaveLength(0);
    s.feed('sid-1', 'p/foo\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/tmp/foo', ts: Date.now() },
    ]);
  });

  it('handles a partial OSC 7 prefix split across chunks (\\x1b]7 then ;...)', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', 'pre\x1b]7');
    expect(events).toHaveLength(0);
    s.feed('sid-1', ';file:///x\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/x', ts: Date.now() },
    ]);
  });

  it('keeps per-sid buffers isolated', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);

    s.feed('sid-A', 'x\x1b]7;file:///pa'); // partial on A
    s.feed('sid-B', '\x1b]7;file:///done\x07'); // complete on B

    expect(events).toEqual([
      { sid: 'sid-B', cwd: '/done', ts: Date.now() },
    ]);

    s.feed('sid-A', 'rtial\x07');
    expect(events).toEqual([
      { sid: 'sid-B', cwd: '/done', ts: Date.now() },
      { sid: 'sid-A', cwd: '/partial', ts: Date.now() },
    ]);
  });

  it('does not emit on plain text chunks with no OSC', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', 'hello world\nno escapes here at all\n');
    expect(events).toHaveLength(0);
  });

  it('does not emit (silently drops) on a non-file:// OSC 7 body', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;http://nope/path\x07');
    expect(events).toHaveLength(0);
    // A subsequent valid OSC 7 still parses.
    s.feed('sid-1', '\x1b]7;file:///ok\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/ok', ts: Date.now() },
    ]);
  });

  it('does not emit on malformed percent-encoded body', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;file:///bad/%ZZ\x07');
    expect(events).toHaveLength(0);
  });

  it('clear(sid) drops any pending partial buffer', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);

    s.feed('sid-1', '\x1b]7;file:///will-be-drop'); // partial
    s.clear('sid-1');

    // Feeding the would-be terminator alone should not produce an emit
    // because the prefix is gone.
    s.feed('sid-1', 'ped\x07');
    expect(events).toHaveLength(0);

    // And the sniffer should still work for a fresh OSC 7.
    s.feed('sid-1', '\x1b]7;file:///fresh\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/fresh', ts: Date.now() },
    ]);
  });

  it('caps buffer growth on long OSC-free streams', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);

    const noise = 'x'.repeat(100 * 1024); // 100 KiB, no OSC
    s.feed('sid-1', noise);

    expect(events).toHaveLength(0);
    const internal = (s as unknown as { buffers: Map<string, string> }).buffers;
    const tail = internal.get('sid-1') ?? '';
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
    expect(tail.length).toBeLessThan(noise.length);

    // And a follow-up OSC 7 still parses.
    s.feed('sid-1', '\x1b]7;file:///ok\x07');
    expect(events).toEqual([{ sid: 'sid-1', cwd: '/ok', ts: Date.now() }]);
  });

  it('caps buffer growth on a never-terminated OSC 7', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);

    s.feed('sid-1', '\x1b]7;file:///' + 'A'.repeat(100 * 1024));
    expect(events).toHaveLength(0);

    const internal = (s as unknown as { buffers: Map<string, string> }).buffers;
    const tail = internal.get('sid-1') ?? '';
    expect(tail.length).toBeLessThanOrEqual(64 * 1024);
  });

  it('stamps ts from Date.now() on each emit', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);

    vi.setSystemTime(new Date('2026-05-04T12:00:00Z'));
    const t1 = Date.now();
    s.feed('sid-1', '\x1b]7;file:///first\x07');

    vi.setSystemTime(new Date('2026-05-04T12:00:05Z'));
    const t2 = Date.now();
    s.feed('sid-1', '\x1b]7;file:///second\x07');

    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/first', ts: t1 },
      { sid: 'sid-1', cwd: '/second', ts: t2 },
    ]);
    expect(t2).toBeGreaterThan(t1);
  });

  it('ignores empty/null chunks safely', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '');
    s.feed('sid-1', Buffer.alloc(0));
    expect(events).toHaveLength(0);
  });

  it('accepts Buffer input', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', Buffer.from('\x1b]7;file:///buf\x07', 'utf8'));
    expect(events).toEqual([{ sid: 'sid-1', cwd: '/buf', ts: Date.now() }]);
  });

  it('decodes Windows-style drive path with leading-slash stripped', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed('sid-1', '\x1b]7;file:///C:/Users/foo\x07');
    expect(events).toEqual([
      { sid: 'sid-1', cwd: 'C:/Users/foo', ts: Date.now() },
    ]);
  });

  it('decodes percent-encoded spaces and unicode in cwd', () => {
    const s = new OscCwdSniffer();
    const events = collect(s);
    s.feed(
      'sid-1',
      '\x1b]7;file:///tmp/with%20space/%E4%B8%AD%E6%96%87\x07',
    );
    expect(events).toEqual([
      { sid: 'sid-1', cwd: '/tmp/with space/中文', ts: Date.now() },
    ]);
  });
});
