import { describe, it, expect } from 'vitest';
import { PassThrough, Readable } from 'node:stream';
import {
  splitNDJSON,
  NDJSONSplitter,
  type LineEvent,
  type ErrorEvent,
} from '../ndjson-splitter';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Feed a sequence of chunks into a PassThrough on next ticks, then end.
 * Chunks may be strings or Buffers — the splitter accepts both.
 */
function feed(chunks: Array<string | Buffer>): PassThrough {
  // PassThrough in default (binary) mode accepts both Buffer and string.
  // We DO NOT call setEncoding here — the splitter does that itself.
  const pt = new PassThrough();
  // Push synchronously so the consumer sees them as separate 'data' events
  // when it attaches in the same tick. We schedule on microtasks so the
  // consumer always has a chance to install listeners first.
  queueMicrotask(() => {
    for (const c of chunks) pt.write(c);
    pt.end();
  });
  return pt;
}

async function collect(
  stream: NodeJS.ReadableStream,
  opts?: { maxLineLength?: number },
): Promise<Array<LineEvent | ErrorEvent>> {
  const out: Array<LineEvent | ErrorEvent> = [];
  for await (const ev of splitNDJSON(stream, opts)) out.push(ev);
  return out;
}

function lines(events: Array<LineEvent | ErrorEvent>): string[] {
  return events
    .filter((e): e is LineEvent => e.type === 'line')
    .map((e) => e.raw);
}

function errors(events: Array<LineEvent | ErrorEvent>): ErrorEvent[] {
  return events.filter((e): e is ErrorEvent => e.type === 'error');
}

// ---------------------------------------------------------------------------
// 1. Normal multi-line
// ---------------------------------------------------------------------------

describe('splitNDJSON — basic', () => {
  it('emits each complete line for a normal multi-line input', async () => {
    const input =
      '{"a":1}\n' +
      '{"b":2}\n' +
      '{"c":3}\n';
    const events = await collect(feed([input]));
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}', '{"c":3}']);
    expect(errors(events)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 2. Half-line across chunks
  // ---------------------------------------------------------------------------
  it('reassembles a line split across two chunks', async () => {
    // First chunk ends mid-JSON.
    const events = await collect(feed(['{"a":1}\n{"hello":"wo', 'rld"}\n{"c":3}\n']));
    expect(lines(events)).toEqual(['{"a":1}', '{"hello":"world"}', '{"c":3}']);
    expect(errors(events)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 3. Giant single line, fed in 50 chunks
  // ---------------------------------------------------------------------------
  it('correctly assembles a 500KB single line fed in 50 chunks', async () => {
    const SIZE = 500 * 1024; // 500 KiB
    const payload = 'x'.repeat(SIZE);
    const json = `{"big":"${payload}"}`;
    const fullLine = json + '\n';
    // Split into 50 roughly-equal pieces.
    const pieceLen = Math.ceil(fullLine.length / 50);
    const chunks: string[] = [];
    for (let i = 0; i < fullLine.length; i += pieceLen) {
      chunks.push(fullLine.slice(i, i + pieceLen));
    }
    expect(chunks.length).toBeGreaterThanOrEqual(50);

    const events = await collect(feed(chunks));
    const ls = lines(events);
    expect(ls).toHaveLength(1);
    expect(ls[0]).toBe(json);
    expect(ls[0].length).toBe(json.length);
    expect(errors(events)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 4. UTF-8 multi-byte char split across chunk boundary
  // ---------------------------------------------------------------------------
  it('handles UTF-8 multi-byte chars split across chunk boundaries', async () => {
    // 你好🌍 — '你'/'好' are 3-byte UTF-8 each, '🌍' is a 4-byte sequence
    // (which is a surrogate pair in UTF-16, but a single 4-byte sequence in
    // UTF-8). We construct a JSON line and split its UTF-8 byte buffer
    // mid-character to verify Node's StringDecoder (engaged by our
    // setEncoding('utf8')) buffers the partial bytes.
    const text = '你好🌍世界';
    const line = JSON.stringify({ msg: text });
    const buf = Buffer.from(line + '\n', 'utf8');

    // Find a split point that lands inside '🌍' (which starts after
    // "你好" = 6 bytes, plus the JSON prefix `{"msg":"`).
    const prefix = Buffer.from('{"msg":"', 'utf8').length; // 8
    const niBytes = Buffer.from('你', 'utf8').length; // 3
    const haoBytes = Buffer.from('好', 'utf8').length; // 3
    const splitInsideEmoji = prefix + niBytes + haoBytes + 2; // 2 bytes into the 4-byte emoji

    const chunkA = buf.subarray(0, splitInsideEmoji);
    const chunkB = buf.subarray(splitInsideEmoji);

    // Sanity: chunkA on its own would be invalid UTF-8 if naively decoded.
    expect(chunkA.length).toBe(splitInsideEmoji);
    expect(chunkB.length).toBe(buf.length - splitInsideEmoji);

    const events = await collect(feed([chunkA, chunkB]));
    expect(errors(events)).toHaveLength(0);
    expect(lines(events)).toEqual([line]);
    // And the parsed JSON round-trips.
    expect(JSON.parse(lines(events)[0])).toEqual({ msg: text });
  });

  // Bonus: 1-byte-at-a-time feed of the same multi-byte content. This is the
  // pathological case — every chunk except the ASCII ones lands inside a
  // multi-byte sequence.
  it('handles UTF-8 multi-byte chars when fed one byte per chunk', async () => {
    const text = '你好🌍';
    const line = JSON.stringify({ m: text });
    const buf = Buffer.from(line + '\n', 'utf8');
    const chunks: Buffer[] = [];
    for (let i = 0; i < buf.length; i++) chunks.push(buf.subarray(i, i + 1));

    const events = await collect(feed(chunks));
    expect(errors(events)).toHaveLength(0);
    expect(lines(events)).toEqual([line]);
    expect(JSON.parse(lines(events)[0])).toEqual({ m: text });
  });

  // ---------------------------------------------------------------------------
  // 5. Empty lines (\n\n) are skipped
  // ---------------------------------------------------------------------------
  it('skips empty lines (consecutive newlines)', async () => {
    const events = await collect(feed(['{"a":1}\n\n{"b":2}\n']));
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}']);
    expect(errors(events)).toHaveLength(0);
  });

  it('skips leading and trailing blank lines', async () => {
    const events = await collect(feed(['\n\n{"a":1}\n\n\n{"b":2}\n\n']));
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}']);
  });

  // ---------------------------------------------------------------------------
  // 6. No trailing newline on last line
  // ---------------------------------------------------------------------------
  it('emits the final line on stream end even without a trailing newline', async () => {
    const events = await collect(feed(['{"a":1}\n{"b":2}']));
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}']);
    expect(errors(events)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 7. Completely empty stream
  // ---------------------------------------------------------------------------
  it('emits nothing for an empty stream', async () => {
    const events = await collect(feed([]));
    expect(events).toHaveLength(0);
  });

  it('emits nothing for a stream containing only newlines', async () => {
    const events = await collect(feed(['\n\n\n']));
    expect(events).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // 8. Giant chunk + many lines mixed (200 lines + half-line in 100KB chunk)
  // ---------------------------------------------------------------------------
  it('handles a 100KB chunk containing 200 complete lines + a trailing half-line', async () => {
    const N = 200;
    const completeLines: string[] = [];
    let buf = '';
    for (let i = 0; i < N; i++) {
      const line = JSON.stringify({ i, pad: 'p'.repeat(400) }); // ~ 415 chars
      completeLines.push(line);
      buf += line + '\n';
    }
    // Append a half-line (no trailing newline) at the end of the giant chunk.
    const halfLine = '{"trailing":"par';
    buf += halfLine;
    expect(buf.length).toBeGreaterThan(80 * 1024); // sanity: big chunk

    // Second chunk completes the half-line.
    const tail = 'tial"}\n';

    const events = await collect(feed([buf, tail]));
    expect(errors(events)).toHaveLength(0);
    const ls = lines(events);
    expect(ls).toHaveLength(N + 1);
    expect(ls.slice(0, N)).toEqual(completeLines);
    expect(ls[N]).toBe('{"trailing":"partial"}');
  });

  // ---------------------------------------------------------------------------
  // Bonus: CRLF tolerance (claude.exe shouldn't emit it, but be safe)
  // ---------------------------------------------------------------------------
  it('strips trailing \\r so CRLF-terminated lines parse cleanly', async () => {
    const events = await collect(feed(['{"a":1}\r\n{"b":2}\r\n']));
    expect(lines(events)).toEqual(['{"a":1}', '{"b":2}']);
  });

  // ---------------------------------------------------------------------------
  // Bonus: max-line-length overflow emits ErrorEvent and recovers
  // ---------------------------------------------------------------------------
  it('emits an ErrorEvent and recovers when a line exceeds maxLineLength', async () => {
    const giant = 'a'.repeat(2048); // way over our 1024 cap
    const events = await collect(
      feed([giant, '\n{"ok":1}\n']),
      { maxLineLength: 1024 },
    );
    const errs = errors(events);
    expect(errs).toHaveLength(1);
    expect(errs[0].error.message).toMatch(/exceeded maxLineLength=1024/);
    expect(errs[0].context.length).toBeLessThanOrEqual(200);
    // After overflow we drop the in-flight buffer; subsequent lines parse.
    expect(lines(events)).toEqual(['{"ok":1}']);
  });

  // ---------------------------------------------------------------------------
  // Bonus: stream 'error' is propagated
  // ---------------------------------------------------------------------------
  it('rethrows stream errors from the async iterator', async () => {
    const pt = new PassThrough();
    queueMicrotask(() => {
      pt.write('{"a":1}\n');
      pt.destroy(new Error('pipe broken'));
    });
    const out: Array<LineEvent | ErrorEvent> = [];
    await expect(async () => {
      for await (const ev of splitNDJSON(pt)) out.push(ev);
    }).rejects.toThrow(/pipe broken/);
    // The line that arrived before the error is still surfaced.
    expect(lines(out)).toEqual(['{"a":1}']);
  });
});

// ---------------------------------------------------------------------------
// EventEmitter API
// ---------------------------------------------------------------------------

describe('NDJSONSplitter (EventEmitter)', () => {
  it('emits line/end events for normal input', async () => {
    const pt = feed(['{"a":1}\n{"b":2}\n']);
    const seen: string[] = [];
    const splitter = new NDJSONSplitter(pt);
    const done = new Promise<void>((resolve) => splitter.on('end', resolve));
    splitter.on('line', (raw) => seen.push(raw));
    await done;
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('flushes a trailing line with no newline on end', async () => {
    const pt = feed(['{"a":1}']);
    const seen: string[] = [];
    const splitter = new NDJSONSplitter(pt);
    const done = new Promise<void>((resolve) => splitter.on('end', resolve));
    splitter.on('line', (raw) => seen.push(raw));
    await done;
    expect(seen).toEqual(['{"a":1}']);
  });

  it('emits error event on overflow without throwing', async () => {
    const pt = feed(['a'.repeat(2048), '\n{"ok":1}\n']);
    const splitter = new NDJSONSplitter(pt, { maxLineLength: 1024 });
    const errs: Error[] = [];
    const ls: string[] = [];
    const done = new Promise<void>((resolve) => splitter.on('end', resolve));
    splitter.on('error', (e) => errs.push(e));
    splitter.on('line', (l) => ls.push(l));
    await done;
    expect(errs).toHaveLength(1);
    expect(ls).toEqual(['{"ok":1}']);
  });

  it('handles Readable.from() string source', async () => {
    const src = Readable.from(['{"a":1}\n', '{"b":2}\n']);
    const seen: string[] = [];
    const splitter = new NDJSONSplitter(src);
    const done = new Promise<void>((resolve) => splitter.on('end', resolve));
    splitter.on('line', (raw) => seen.push(raw));
    await done;
    expect(seen).toEqual(['{"a":1}', '{"b":2}']);
  });
});
