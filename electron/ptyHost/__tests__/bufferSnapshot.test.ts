// L4 PR-A (#861): pins the headless authoritative buffer + getBufferSnapshot
// contract.
//
// Two layers of coverage:
//   1. Real @xterm/headless + @xterm/addon-serialize wired with the
//      production scrollback cap — pins write accumulation, scrollback
//      truncation, and snapshot round-trip.
//   2. Pure lifecycle.getBufferSnapshot over a fake sessions map — pins
//      missing-sid behavior and the chunked-yield contract (each chunk
//      yields a macrotask so the main thread isn't blocked on big buffers).
//
// Out of scope (PR-B/E): visible xterm replay, IPC wire format, detach/reattach.

import { describe, it, expect, vi } from 'vitest';

// `lifecycle.getBufferSnapshot` now consults the user's scrollbackLines
// preference (electron/prefs/scrollback) on every call so the cap honors
// live setting changes. The prefs module imports `../db`, which calls
// Electron's `app.getPath()` on first use — fatal in pure-node tests.
// Stub the prefs module to a fixed cap so the lifecycle path stays
// hermetic. Each individual test that wants to assert "the cap is
// passed to serialize" overrides this via vi.mocked(...) below.
let _stubbedCap = 1500;
vi.mock('../../prefs/scrollback', () => ({
  loadScrollbackLines: () => _stubbedCap,
  DEFAULT_SCROLLBACK_LINES: 1500,
  MIN_SCROLLBACK_LINES: 100,
  MAX_SCROLLBACK_LINES: 50000,
  SCROLLBACK_KEY: 'scrollbackLines',
  parseScrollbackLines: (v: unknown) => (typeof v === 'number' ? v : 1500),
  invalidateScrollbackCache: () => {},
  subscribeScrollbackInvalidation: () => () => {},
}));

import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { SCROLLBACK } from '../entryFactory';
import {
  getBufferSnapshot,
  SNAPSHOT_CHUNK_LINES,
} from '../lifecycle';
import type { Entry } from '../entryFactory';

function makeRealHeadless(): { term: HeadlessTerminal; serialize: SerializeAddon } {
  const term = new HeadlessTerminal({
    cols: 80,
    rows: 24,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  term.loadAddon(serialize);
  return { term, serialize };
}

// Build a fake Entry that just exposes a `serialize.serialize(opts?)` echoing
// back whatever string the test supplied. The `optsCapture` array (when
// passed) records every options arg the lifecycle layer hands through, so
// tests can assert the user-configured cap reaches SerializeAddon.
function fakeEntry(
  snapshot: string,
  seq: number = 0,
  optsCapture?: unknown[],
): Entry {
  return {
    pty: { pid: 0 } as Entry['pty'],
    // Round-4 fix: `getBufferSnapshot` now drains the headless parser
    // queue before reading seq + serializing (see lifecycle.ts comment
    // on the dispatch/seq race). The fake must implement
    // `write('', cb)` so the drain await resolves; the actual chunk is
    // unused — serialize() returns the snapshot string the test
    // configured.
    headless: {
      write: (_chunk: string, cb?: () => void) => {
        if (cb) cb();
      },
    } as unknown as Entry['headless'],
    serialize: {
      serialize: (opts?: unknown) => {
        if (optsCapture) optsCapture.push(opts);
        return snapshot;
      },
    } as unknown as Entry['serialize'],
    attached: new Map(),
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    seq,
  };
}

describe('headless authoritative buffer (PR-A real wiring)', () => {
  it('SCROLLBACK default cap is 1500 lines', () => {
    expect(SCROLLBACK).toBe(1500);
  });

  it('headless buffer accumulates writes across chunks', async () => {
    const { term, serialize } = makeRealHeadless();
    await new Promise<void>((r) => term.write('hello ', r));
    await new Promise<void>((r) => term.write('world\r\n', r));
    await new Promise<void>((r) => term.write('second line', r));
    const snap = serialize.serialize();
    expect(snap).toContain('hello world');
    expect(snap).toContain('second line');
  });

  it('scrollback cap of SCROLLBACK truncates the OLDEST lines once exceeded', async () => {
    const { term, serialize } = makeRealHeadless();
    // Write more lines than the cap. After the cap, the oldest lines
    // should be evicted while the newest survive.
    const TOTAL = SCROLLBACK + 500;
    let buf = '';
    for (let i = 0; i < TOTAL; i++) buf += `LINE${i}\r\n`;
    await new Promise<void>((r) => term.write(buf, r));
    const snap = serialize.serialize();
    // Newest line must survive.
    expect(snap).toContain(`LINE${TOTAL - 1}`);
    // The very first line MUST have been evicted (well under the cap window).
    expect(snap).not.toContain('LINE0\n');
    // A line comfortably inside the surviving cap window must still be present.
    expect(snap).toContain(`LINE${TOTAL - 100}`);
  });

  it('snapshot round-trips: writing the snapshot into a fresh terminal reproduces the visible text', async () => {
    const { term, serialize } = makeRealHeadless();
    await new Promise<void>((r) => term.write('alpha\r\nbeta\r\ngamma', r));
    const snap = serialize.serialize();

    const fresh = new HeadlessTerminal({ cols: 80, rows: 24, allowProposedApi: true });
    await new Promise<void>((r) => fresh.write(snap, r));
    // Read back the visible buffer line-by-line.
    let restored = '';
    for (let row = 0; row < fresh.buffer.active.length; row++) {
      const line = fresh.buffer.active.getLine(row);
      if (line) restored += line.translateToString(true) + '\n';
    }
    expect(restored).toContain('alpha');
    expect(restored).toContain('beta');
    expect(restored).toContain('gamma');
  });
});

describe('lifecycle.getBufferSnapshot (PR-A async chunking + PR-B seq capture)', () => {
  it('returns empty snapshot + seq 0 when the sid is not registered', async () => {
    const sessions = new Map<string, Entry>();
    expect(await getBufferSnapshot(sessions, 'missing')).toEqual({ snapshot: '', seq: 0 });
  });

  it('returns the full snapshot + entry.seq when the buffer fits in one chunk (no yield needed)', async () => {
    const sessions = new Map<string, Entry>();
    const small = Array.from({ length: 50 }, (_, i) => `row-${i}`).join('\n');
    sessions.set('s1', fakeEntry(small, 42));
    const result = await getBufferSnapshot(sessions, 's1');
    expect(result).toEqual({ snapshot: small, seq: 42 });
  });

  it('chunked path preserves the full string verbatim across yields and returns entry.seq', async () => {
    const sessions = new Map<string, Entry>();
    const N = SNAPSHOT_CHUNK_LINES * 3 + 17; // forces at least 4 chunks
    const big = Array.from({ length: N }, (_, i) => `row-${i}`).join('\n');
    sessions.set('s2', fakeEntry(big, 99));
    const result = await getBufferSnapshot(sessions, 's2');
    expect(result.snapshot).toBe(big);
    expect(result.snapshot.split('\n')).toHaveLength(N);
    expect(result.seq).toBe(99);
  });

  it('chunked path yields a macrotask between chunks (does not block the event loop)', async () => {
    const sessions = new Map<string, Entry>();
    // Force exactly 5 chunks => 4 inter-chunk yields.
    const N = SNAPSHOT_CHUNK_LINES * 5;
    const big = Array.from({ length: N }, (_, i) => `r${i}`).join('\n');
    sessions.set('s3', fakeEntry(big, 1));

    // A setImmediate scheduled BEFORE awaiting getBufferSnapshot must have
    // a chance to fire WHILE the chunked loop is still running, proving the
    // loop yields. We count immediates that fire before the snapshot
    // resolves; with chunking >0, without chunking == 0.
    let immediateFired = 0;
    const tickEveryFrame = (): void => {
      setImmediate(() => {
        immediateFired += 1;
        if (immediateFired < 10) tickEveryFrame();
      });
    };
    tickEveryFrame();

    await getBufferSnapshot(sessions, 's3');
    // Expect at least the number of inter-chunk yields - 1; in practice
    // we should see >= 3 immediates fire alongside 4 internal yields.
    expect(immediateFired).toBeGreaterThanOrEqual(3);
  });

  it('passes the user-configured scrollback cap as serialize options', async () => {
    const sessions = new Map<string, Entry>();
    const optsCapture: unknown[] = [];
    sessions.set('s4', fakeEntry('payload', 7, optsCapture));
    _stubbedCap = 1500;
    await getBufferSnapshot(sessions, 's4');
    expect(optsCapture).toHaveLength(1);
    expect(optsCapture[0]).toEqual({ scrollback: 1500 });
  });

  it('honors a changed scrollback cap on subsequent calls (live setting)', async () => {
    const sessions = new Map<string, Entry>();
    const optsCapture: unknown[] = [];
    sessions.set('s5', fakeEntry('payload', 0, optsCapture));
    _stubbedCap = 200;
    await getBufferSnapshot(sessions, 's5');
    _stubbedCap = 9000;
    await getBufferSnapshot(sessions, 's5');
    expect(optsCapture).toEqual([{ scrollback: 200 }, { scrollback: 9000 }]);
  });

  it('returns at most `cap` lines when serialize honors the option (real addon, real cap)', async () => {
    // End-to-end check against the real SerializeAddon: a buffer with
    // many more rows than the cap should yield a snapshot whose line
    // count is bounded by the cap (plus some constant for terminal
    // mode/style prefixes).
    _stubbedCap = 500;
    const { term, serialize } = makeRealHeadless();
    const TOTAL = 3000;
    let buf = '';
    for (let i = 0; i < TOTAL; i++) buf += `L${i}\r\n`;
    await new Promise<void>((r) => term.write(buf, r));

    const sessions = new Map<string, Entry>();
    // Wire the real entry's serialize so getBufferSnapshot calls the
    // real addon with our cap.
    sessions.set('real', {
      pty: { pid: 0 } as Entry['pty'],
      headless: term as unknown as Entry['headless'],
      serialize: serialize as unknown as Entry['serialize'],
      attached: new Map(),
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      seq: 0,
    } as Entry);
    const result = await getBufferSnapshot(sessions, 'real');
    // Sanity: the newest line must survive.
    expect(result.snapshot).toContain(`L${TOTAL - 1}`);
    // The cap must have evicted lines well outside the bottom 500
    // — anything older than ~600 lines from the bottom should be gone.
    expect(result.snapshot).not.toContain(`L${TOTAL - 1000}`);
    // Conservative line-count cap: 500 + a small overhead for ANSI
    // escapes and trailing rows. We just assert "much less than TOTAL".
    expect(result.snapshot.split('\n').length).toBeLessThan(700);
  });

  // Round-4 (PR #1355 dogfood): the snapshot.seq vs. serialize-content
  // race that breaks the warm-xterm dedupe gate under fast bursts.
  //
  // Setup: real headless + serialize. Burst many chunks via
  // `headless.write` WITHOUT awaiting their callbacks — exactly what
  // `dispatchPtyChunk` does in production (it issues write+cb and bumps
  // entry.seq synchronously before the write has been parsed). Then
  // immediately await `getBufferSnapshot`.
  //
  // BEFORE the fix:
  //   * `entry.seq` is N (we bumped it N times).
  //   * `serialize.serialize()` reads the headless buffer SYNCHRONOUSLY
  //     and returns whatever has been parsed so far — under burst, this
  //     may be 0 bytes because the parser hasn't drained yet.
  //   * Returned `{snapshot: '', seq: N}` is a lie — it claims "I
  //     contain everything through seq N" but contains nothing.
  //   * In the warm path, buffered chunks with seq ≤ N are dropped and
  //     the content vanishes.
  //
  // AFTER the fix:
  //   * `getBufferSnapshot` writes a zero-length chunk through xterm's
  //     FIFO WriteBuffer and awaits its callback — by xterm's contract
  //     every earlier write has been parsed by then.
  //   * `serialize.serialize()` now sees all N chunks' content.
  //   * Returned snapshot.seq correctly corresponds to the visible
  //     content; warm-path dedupe behaves as designed.
  it('Round 4: snapshot drains parser queue so seq is in-sync with serialize content', async () => {
    _stubbedCap = 1500;
    const { term, serialize } = makeRealHeadless();
    const sessions = new Map<string, Entry>();
    sessions.set('burst', {
      pty: { pid: 0 } as Entry['pty'],
      headless: term as unknown as Entry['headless'],
      serialize: serialize as unknown as Entry['serialize'],
      attached: new Map(),
      cols: 80,
      rows: 24,
      cwd: '/tmp',
      seq: 0,
    } as Entry);
    const entry = sessions.get('burst')!;

    // Simulate dispatchPtyChunk burst: bump seq + queue headless.write,
    // do NOT await the callback. Use a meaningful payload so we can
    // assert it survives.
    const N = 50;
    for (let i = 0; i < N; i++) {
      entry.seq += 1;
      // Fire-and-forget — the chunk goes into WriteBuffer; the callback
      // will fire on a future parser tick. We intentionally don't await.
      term.write(`burst-${i}\r\n`);
    }
    // Synchronous state at this point: entry.seq === N, but
    // `serialize.serialize()` would return very little because the
    // parser hasn't ticked. The fix's drain await inside
    // getBufferSnapshot is what aligns the two.

    const result = await getBufferSnapshot(sessions, 'burst');

    // Contract: snapshot must contain every chunk's content. With the
    // pre-fix code, the snapshot was empty / partial.
    expect(result.snapshot).toContain('burst-0');
    expect(result.snapshot).toContain(`burst-${N - 1}`);
    expect(result.snapshot).toContain('burst-25');
    // seq matches the dispatch count — entry.seq was bumped to N by
    // our synchronous loop, and the drain rendezvous ensures the
    // serialize output reflects all N chunks before seq is read.
    expect(result.seq).toBe(N);
  });
});

