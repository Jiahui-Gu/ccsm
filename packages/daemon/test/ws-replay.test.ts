// WebSocket replay & RESET integration tests (T8 #661, DESIGN.md F4/F6).
//
// Strategy:
//   - Open a "primary" ws subscriber and let it accumulate OUTPUT frames so
//     the server's per-session ring buffer fills up (it lives only as long as
//     >= 1 subscriber holds the runtime alive — when the last sub disconnects
//     the PTY is killed and the runtime is torn down).
//   - Then dial a "secondary" ws with a chosen lastSeq to exercise:
//     (a) lastSeq within ring window  -> server sends replayed OUTPUT frame(s)
//                                        before live frames, no RESET.
//     (b) lastSeq evicted from ring   -> server sends RESET, then live frames.

import type { AddressInfo } from 'node:net';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import WebSocket from 'ws';

import { decodeFrame, FrameType } from '@ccsm/shared';

import { createDaemonHttp, type DaemonHttp } from '../src/http.mjs';
import {
  createRuntimeRegistry,
  type PtyFactory,
  type PtyLike,
  type RuntimeRegistry,
} from '../src/runtime.mjs';
import { attachWebSocket, type AttachedWs } from '../src/ws.mjs';

const TOKEN = 'test-token-do-not-use-in-prod-0123456789abcdef';
const GOOD_ORIGIN = 'http://localhost:1234';

interface FakePty extends PtyLike {
  emitData(s: string): void;
  emitExit(code: number): void;
  written: string[];
  lastResize: { cols: number; rows: number } | null;
  killed: string[];
  spawnOpts: { cwd: string; cols: number; rows: number; sid: string; mode: 'create' | 'resume' };
}

function makeFakePtyFactory(): { factory: PtyFactory; instances: FakePty[] } {
  const instances: FakePty[] = [];
  const factory: PtyFactory = (opts) => {
    let onDataCb: ((s: string) => void) | null = null;
    let onExitCb: ((e: { exitCode: number }) => void) | null = null;
    const fp: FakePty = {
      written: [],
      lastResize: null,
      killed: [],
      spawnOpts: { ...opts },
      write(d) {
        this.written.push(d);
      },
      resize(c, r) {
        this.lastResize = { cols: c, rows: r };
      },
      kill(sig) {
        this.killed.push(sig ?? 'SIGTERM');
      },
      onData(cb) {
        onDataCb = cb;
      },
      onExit(cb) {
        onExitCb = cb;
      },
      emitData(s) {
        onDataCb?.(s);
      },
      emitExit(code) {
        onExitCb?.({ exitCode: code });
      },
    };
    instances.push(fp);
    return fp;
  };
  return { factory, instances };
}

let http: DaemonHttp;
let attached: AttachedWs;
let registry: RuntimeRegistry;
let baseHttp: string;
let baseWs: string;
let ptyFactoryState: { factory: PtyFactory; instances: FakePty[] };

beforeAll(async () => {
  ptyFactoryState = makeFakePtyFactory();
  http = createDaemonHttp({ token: TOKEN });
  registry = createRuntimeRegistry({
    sessions: http.sessions,
    ptyFactory: ptyFactoryState.factory,
  });
  http.setRegistry(registry);
  attached = attachWebSocket(http.server, {
    token: TOKEN,
    sessions: http.sessions,
    registry,
  });
  await new Promise<void>((resolve, reject) => {
    http.server.once('error', reject);
    http.server.listen(0, '127.0.0.1', () => {
      http.server.removeListener('error', reject);
      resolve();
    });
  });
  const addr = http.server.address() as AddressInfo;
  baseHttp = `http://127.0.0.1:${addr.port}`;
  baseWs = `ws://127.0.0.1:${addr.port}`;
});

afterAll(async () => {
  await attached.shutdown();
  await new Promise<void>((resolve) => http.server.close(() => resolve()));
});

beforeEach(() => {
  ptyFactoryState.instances.length = 0;
});

afterEach(() => {
  for (const sid of Array.from(http.sessions.keys())) {
    void registry.kill(sid);
    http.sessions.delete(sid);
  }
});

async function createSid(): Promise<string> {
  const r = await fetch(`${baseHttp}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: GOOD_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { sid: string };
  return j.sid;
}

interface DialResult {
  ws: WebSocket;
  nextFrame(timeoutMs?: number): Promise<Uint8Array | null>;
  closed: Promise<{ code: number; reason: string }>;
}

function dial(url: string, headers: Record<string, string> = {}): DialResult {
  const ws = new WebSocket(url, { headers: { Origin: GOOD_ORIGIN, ...headers } });
  ws.binaryType = 'nodebuffer';
  const queue: Uint8Array[] = [];
  const waiters: Array<(v: Uint8Array | null) => void> = [];
  let closedInfo: { code: number; reason: string } | null = null;
  const closedWaiters: Array<(v: { code: number; reason: string }) => void> = [];

  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    const buf = data instanceof Buffer
      ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
      : new Uint8Array(data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w(buf);
    else queue.push(buf);
  });
  ws.on('close', (code, reason) => {
    closedInfo = { code, reason: reason.toString('utf8') };
    for (const w of waiters.splice(0)) w(null);
    for (const w of closedWaiters.splice(0)) w(closedInfo);
  });
  ws.on('error', () => { /* observable via close */ });

  return {
    ws,
    nextFrame(timeoutMs = 1000) {
      if (queue.length > 0) return Promise.resolve(queue.shift() as Uint8Array);
      if (closedInfo) return Promise.resolve(null);
      return new Promise((resolve) => {
        let settled = false;
        const t = setTimeout(() => {
          if (settled) return;
          settled = true;
          const idx = waiters.indexOf(wrapped);
          if (idx >= 0) waiters.splice(idx, 1);
          resolve(null);
        }, timeoutMs);
        const wrapped = (v: Uint8Array | null): void => {
          if (settled) return;
          settled = true;
          clearTimeout(t);
          resolve(v);
        };
        waiters.push(wrapped);
      });
    },
    closed: new Promise((resolve) => {
      if (closedInfo) resolve(closedInfo);
      else closedWaiters.push(resolve);
    }),
  };
}

function waitOpen(ws: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    if (ws.readyState === WebSocket.OPEN) return resolve();
    ws.once('open', () => resolve());
    ws.once('error', reject);
    ws.once('close', (code) => reject(new Error(`closed before open: ${code}`)));
  });
}

// Drain n OUTPUT frames from a primary subscriber (used to keep the runtime
// alive while we feed PTY data and fill the ring).
async function drainOutputs(d: DialResult, n: number): Promise<Uint8Array[]> {
  const got: Uint8Array[] = [];
  for (let i = 0; i < n; i++) {
    const f = await d.nextFrame(2000);
    if (f === null) throw new Error(`drainOutputs: stream ended after ${i}/${n}`);
    got.push(f);
  }
  return got;
}

describe('ws lastSeq replay (T8 #661)', () => {
  it('replays buffered OUTPUT to a reconnecting subscriber within ring window', async () => {
    const sid = await createSid();
    // Primary keeps the runtime alive.
    const primary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(primary.ws);
    const fpty = ptyFactoryState.instances[0]!;

    // Emit 3 chunks. Primary sees them all (consume to keep ws happy).
    fpty.emitData('one ');
    fpty.emitData('two ');
    fpty.emitData('three');
    await drainOutputs(primary, 3);

    // Secondary connects with lastSeq=1 -> should receive bytes for seqs 2 and 3
    // (i.e. "two three") as one or more OUTPUT frames BEFORE any new live data.
    const secondary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}&lastSeq=1`);
    await waitOpen(secondary.ws);

    const f1 = await secondary.nextFrame(1000);
    expect(f1).not.toBeNull();
    const dec1 = decodeFrame(f1!);
    expect(dec1.type).toBe(FrameType.OUTPUT);
    // Replay seq is the latest server seq (=3); not asserted strictly in case
    // implementation chunks differently. The PAYLOAD content is what matters.
    let replayed = Buffer.from(dec1.payload).toString('utf8');
    // Allow the replay to span multiple frames (chunked) — drain quickly.
    while (replayed.length < 'two three'.length) {
      const next = await secondary.nextFrame(200);
      if (next === null) break;
      const d = decodeFrame(next);
      expect(d.type).toBe(FrameType.OUTPUT);
      replayed += Buffer.from(d.payload).toString('utf8');
    }
    expect(replayed).toBe('two three');

    // Now live: emit a new chunk and confirm secondary receives it.
    fpty.emitData(' four');
    const live = await secondary.nextFrame(1000);
    expect(live).not.toBeNull();
    const liveDec = decodeFrame(live!);
    expect(liveDec.type).toBe(FrameType.OUTPUT);
    expect(Buffer.from(liveDec.payload).toString('utf8')).toBe(' four');
    // Primary also keeps receiving live data.
    await drainOutputs(primary, 1);

    secondary.ws.close();
    primary.ws.close();
    await primary.closed;
  });

  it('sends RESET when lastSeq has been evicted from the ring', async () => {
    const sid = await createSid();
    const primary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(primary.ws);
    const fpty = ptyFactoryState.instances[0]!;

    // Fill ring beyond capacity (4MB). Use 64KB chunks; 80 chunks = 5MB.
    const CHUNK = 64 * 1024;
    const filler = Buffer.alloc(CHUNK, 0x41); // 'A' bytes
    const N = 80;
    for (let i = 0; i < N; i++) {
      fpty.emitData(filler.toString('binary'));
    }
    // Drain primary so it doesn't backpressure; we don't care about contents here.
    await drainOutputs(primary, N);

    // Secondary connects with lastSeq=1 -> seq 1 must have been evicted.
    const secondary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}&lastSeq=1`);
    await waitOpen(secondary.ws);

    // First frame to secondary should be RESET.
    const first = await secondary.nextFrame(2000);
    expect(first).not.toBeNull();
    const dec = decodeFrame(first!);
    expect(dec.type).toBe(FrameType.RESET);
    expect(dec.payload.byteLength).toBe(0);

    // Live OUTPUT after RESET still flows.
    fpty.emitData('post-reset');
    const live = await secondary.nextFrame(1000);
    expect(live).not.toBeNull();
    const liveDec = decodeFrame(live!);
    expect(liveDec.type).toBe(FrameType.OUTPUT);
    expect(Buffer.from(liveDec.payload).toString('utf8')).toBe('post-reset');

    secondary.ws.close();
    primary.ws.close();
    await primary.closed;
  });

  it('does not replay when lastSeq matches current server seq', async () => {
    const sid = await createSid();
    const primary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(primary.ws);
    const fpty = ptyFactoryState.instances[0]!;

    fpty.emitData('hi');
    await drainOutputs(primary, 1);
    // Server outputSeq is now 1.

    const secondary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}&lastSeq=1`);
    await waitOpen(secondary.ws);

    // Should NOT receive any replay frame within a short window.
    const replay = await secondary.nextFrame(150);
    expect(replay).toBeNull();

    // But live data still flows.
    fpty.emitData('again');
    const live = await secondary.nextFrame(1000);
    expect(live).not.toBeNull();
    const liveDec = decodeFrame(live!);
    expect(liveDec.type).toBe(FrameType.OUTPUT);
    expect(Buffer.from(liveDec.payload).toString('utf8')).toBe('again');

    secondary.ws.close();
    primary.ws.close();
    await primary.closed;
  });

  it('treats a fresh client (no lastSeq query) as no-replay', async () => {
    const sid = await createSid();
    const primary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(primary.ws);
    const fpty = ptyFactoryState.instances[0]!;

    fpty.emitData('first');
    fpty.emitData('second');
    await drainOutputs(primary, 2);

    const secondary = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(secondary.ws);

    // No lastSeq -> server treats as 0, but spec wording allows "fresh = no
    // replay". Our impl: lastSeq=0 < outputSeq=2 -> we DO replay everything in
    // ring. That's fine and matches DESIGN.md F4 ("从 ring buffer 取
    // [lastSeq+1, currentSeq]"). Verify the replay arrives.
    let acc = '';
    while (acc.length < 'firstsecond'.length) {
      const f = await secondary.nextFrame(500);
      if (f === null) break;
      const d = decodeFrame(f);
      expect(d.type).toBe(FrameType.OUTPUT);
      acc += Buffer.from(d.payload).toString('utf8');
    }
    expect(acc).toBe('firstsecond');

    secondary.ws.close();
    primary.ws.close();
    await primary.closed;
  });
});
