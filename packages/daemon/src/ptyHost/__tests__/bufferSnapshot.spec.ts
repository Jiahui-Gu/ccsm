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

import { describe, it, expect } from 'vitest';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { SCROLLBACK } from '../entryFactory.js';
import {
  getBufferSnapshot,
  SNAPSHOT_CHUNK_LINES,
} from '../lifecycle.js';
import type { Entry } from '../entryFactory.js';

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

// Build a fake Entry that just exposes a `serialize.serialize()` returning
// the supplied string. Other Entry fields are stubbed because
// getBufferSnapshot only reads `entry.serialize` and `entry.seq`.
function fakeEntry(snapshot: string, seq: number = 0): Entry {
  return {
    pty: { pid: 0 } as Entry['pty'],
    headless: {} as Entry['headless'],
    serialize: { serialize: () => snapshot } as unknown as Entry['serialize'],
    attached: new Map(),
    cols: 80,
    rows: 24,
    cwd: '/tmp',
    seq,
    pendingHeadlessWrites: 0,
    backpressureWarned: false,
  };
}

describe('headless authoritative buffer (PR-A real wiring)', () => {
  it('SCROLLBACK is bumped to 10000 lines for L4', () => {
    expect(SCROLLBACK).toBe(10000);
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

  it('scrollback cap of 10000 truncates the OLDEST lines once exceeded', async () => {
    const { term, serialize } = makeRealHeadless();
    // Write 10500 distinct lines. After the cap, the first ~500 + the 24
    // visible rows offset should be gone.
    const TOTAL = 10500;
    let buf = '';
    for (let i = 0; i < TOTAL; i++) buf += `LINE${i}\r\n`;
    await new Promise<void>((r) => term.write(buf, r));
    const snap = serialize.serialize();
    // Newest line must survive.
    expect(snap).toContain(`LINE${TOTAL - 1}`);
    // The very first line MUST have been evicted (well under the cap window).
    expect(snap).not.toContain('LINE0\n');
    expect(snap).not.toContain('LINE100\n');
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
});
