// Per-subscriber PAUSE/RESUME backpressure tests (T11 #654, DESIGN.md §5
// frame types + §9 Phase 3).
//
// What we cover here:
//   1. After a client sends PAUSE, OUTPUT bytes from the PTY are NOT pushed
//      to that ws — but other (non-paused) subscribers still receive them.
//   2. After RESUME, the daemon flushes the queued OUTPUT to the formerly-
//      paused client in original order, then live forwarding resumes.
//   3. If the per-subscriber queue exceeds 1MB while paused, the daemon
//      closes the ws with code 1009 (Message Too Big) and other subscribers
//      keep receiving live data.
//   4. PTY exit while paused: the daemon still sends EXIT to the paused
//      subscriber (terminal signal — bypasses the queue and tears down the
//      connection). Documents the simple semantics chosen for T11.
//
// Strategy mirrors ws-replay.test.ts: a fake PTY factory + two ws clients
// (one acts as paused, the other as a control).

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

import { decodeFrame, encodeFrame, FrameType } from '@ccsm/shared';

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
    registry.kill(sid);
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

function sendPause(ws: WebSocket): void {
  ws.send(
    encodeFrame({ type: FrameType.PAUSE, seq: 0, payload: new Uint8Array(0) }),
  );
}

function sendResume(ws: WebSocket): void {
  ws.send(
    encodeFrame({ type: FrameType.RESUME, seq: 0, payload: new Uint8Array(0) }),
  );
}

// Pump pending socket I/O so the server has a chance to receive a control
// frame the test just sent. Two short setTimeouts beat the macrotask queue
// into shape; we rely on this in tests that immediately follow a PAUSE/RESUME.
async function settle(ms = 25): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe('ws PAUSE/RESUME backpressure (T11 #654)', () => {
  it('paused subscriber stops receiving OUTPUT while others continue', async () => {
    const sid = await createSid();
    const a = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    const b = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(a.ws);
    await waitOpen(b.ws);
    const fpty = ptyFactoryState.instances[0]!;

    // 'a' pauses; 'b' stays live.
    sendPause(a.ws);
    await settle();

    fpty.emitData('first');
    fpty.emitData('second');

    // 'b' should receive both immediately.
    const b1 = await b.nextFrame(500);
    const b2 = await b.nextFrame(500);
    expect(b1).not.toBeNull();
    expect(b2).not.toBeNull();
    expect(Buffer.from(decodeFrame(b1!).payload).toString('utf8')).toBe('first');
    expect(Buffer.from(decodeFrame(b2!).payload).toString('utf8')).toBe('second');

    // 'a' should NOT receive any frame within a short window.
    const aSilent = await a.nextFrame(150);
    expect(aSilent).toBeNull();

    a.ws.close();
    b.ws.close();
    await b.closed;
  });

  it('RESUME flushes buffered OUTPUT in order, then live forwarding continues', async () => {
    const sid = await createSid();
    const a = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    const b = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(a.ws);
    await waitOpen(b.ws);
    const fpty = ptyFactoryState.instances[0]!;

    sendPause(a.ws);
    await settle();

    fpty.emitData('one');
    fpty.emitData('two');
    fpty.emitData('three');
    // Drain 'b' so its receive queue doesn't block.
    for (let i = 0; i < 3; i += 1) await b.nextFrame(500);

    // 'a' has nothing yet.
    expect(await a.nextFrame(100)).toBeNull();

    sendResume(a.ws);

    // 'a' should now get exactly the three buffered frames in order.
    const f1 = await a.nextFrame(1000);
    const f2 = await a.nextFrame(500);
    const f3 = await a.nextFrame(500);
    expect(f1).not.toBeNull();
    expect(f2).not.toBeNull();
    expect(f3).not.toBeNull();
    expect(Buffer.from(decodeFrame(f1!).payload).toString('utf8')).toBe('one');
    expect(Buffer.from(decodeFrame(f2!).payload).toString('utf8')).toBe('two');
    expect(Buffer.from(decodeFrame(f3!).payload).toString('utf8')).toBe('three');

    // Live again: a new emitData reaches both subscribers.
    fpty.emitData('four');
    const aLive = await a.nextFrame(500);
    const bLive = await b.nextFrame(500);
    expect(aLive).not.toBeNull();
    expect(bLive).not.toBeNull();
    expect(Buffer.from(decodeFrame(aLive!).payload).toString('utf8')).toBe('four');
    expect(Buffer.from(decodeFrame(bLive!).payload).toString('utf8')).toBe('four');

    a.ws.close();
    b.ws.close();
    await b.closed;
  });

  it('overflowing the 1MB pause queue closes the paused subscriber with 1009', async () => {
    const sid = await createSid();
    const a = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    const b = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(a.ws);
    await waitOpen(b.ws);
    const fpty = ptyFactoryState.instances[0]!;

    sendPause(a.ws);
    await settle();

    // Push > 1MB into 'a's pause queue. 64KB chunks * 20 = 1.25MB.
    const CHUNK = 64 * 1024;
    const filler = Buffer.alloc(CHUNK, 0x42).toString('binary');
    for (let i = 0; i < 20; i += 1) {
      fpty.emitData(filler);
    }
    // Drain 'b' so its receive queue stays small (it is NOT paused).
    for (let i = 0; i < 20; i += 1) await b.nextFrame(2000);

    // 'a' should be closed by the server with code 1009.
    const closed = await a.closed;
    expect(closed.code).toBe(1009);

    // 'b' is still alive and reachable.
    fpty.emitData('still-here');
    const live = await b.nextFrame(1000);
    expect(live).not.toBeNull();
    expect(Buffer.from(decodeFrame(live!).payload).toString('utf8')).toBe('still-here');

    b.ws.close();
    await b.closed;
  });

  it('PTY exit while paused still sends EXIT to the paused subscriber (terminal signal bypass)', async () => {
    const sid = await createSid();
    const a = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(a.ws);
    const fpty = ptyFactoryState.instances[0]!;

    sendPause(a.ws);
    await settle();
    // Generate a small amount of buffered OUTPUT so we know the pause path is active.
    fpty.emitData('buffered');
    await settle();

    // PTY exits — server should send EXIT and close, regardless of paused state.
    fpty.emitExit(7);

    // Drain frames until we see EXIT (the server may also have flushed OUTPUT
    // synchronously around the close; the test only requires that EXIT arrives
    // and the connection closes cleanly).
    let sawExit = false;
    for (let i = 0; i < 5; i += 1) {
      const f = await a.nextFrame(500);
      if (f === null) break;
      const dec = decodeFrame(f);
      if (dec.type === FrameType.EXIT) {
        sawExit = true;
        break;
      }
    }
    expect(sawExit).toBe(true);
    const closed = await a.closed;
    expect(closed.code).toBe(1000);
  });
});
