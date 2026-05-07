// WebSocket server tests for the daemon (Task #659, T4).
// Covers: handshake auth (token, origin), sid lookup, frame echo (INPUT
// round-trip via fake PTY -> OUTPUT broadcast), exit propagation, resize.
//
// Real node-pty is NOT used here — we inject a controllable fake via
// AttachWsOptions.ptyFactory so these tests run on every platform without
// the native addon and without spawning `claude`.

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

import {
  decodeExit,
  decodeFrame,
  encodeFrame,
  encodeResize,
  FrameType,
} from '@ccsm/shared';

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

// ---- Fake PTY -----------------------------------------------------------

interface FakePty extends PtyLike {
  /** Trigger a fake stdout chunk (server will broadcast as OUTPUT). */
  emitData(s: string): void;
  /** Trigger a fake exit (server will broadcast as EXIT and close). */
  emitExit(code: number): void;
  /** Spy: bytes written into the PTY by the server (from INPUT frames). */
  written: string[];
  /** Spy: most recent (cols, rows). */
  lastResize: { cols: number; rows: number } | null;
  /** Spy: kill signals received. */
  killed: string[];
  /** Spy: cwd/cols/rows/sid/mode the factory was constructed with. */
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

// ---- Test fixture -------------------------------------------------------

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
  // Reset spies between tests but reuse factory wiring.
  ptyFactoryState.instances.length = 0;
});

afterEach(() => {
  // Close any sessions created during the test so PTYs don't leak.
  for (const sid of Array.from(http.sessions.keys())) {
    void registry.kill(sid);
    http.sessions.delete(sid);
  }
});

// ---- Helpers ------------------------------------------------------------

async function createSid(cwd?: string): Promise<string> {
  const r = await fetch(`${baseHttp}/api/sessions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Origin: GOOD_ORIGIN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(cwd ? { cwd } : {}),
  });
  expect(r.status).toBe(200);
  const j = (await r.json()) as { sid: string };
  return j.sid;
}

interface DialResult {
  ws: WebSocket;
  /** Resolves on first server frame OR on close (with null). */
  nextFrame(): Promise<Uint8Array | null>;
  /** Resolves with [code, reason]. */
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
    const buf = data instanceof Buffer ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : new Uint8Array(data as ArrayBuffer);
    const w = waiters.shift();
    if (w) w(buf);
    else queue.push(buf);
  });
  ws.on('close', (code, reason) => {
    closedInfo = { code, reason: reason.toString('utf8') };
    for (const w of waiters.splice(0)) w(null);
    for (const w of closedWaiters.splice(0)) w(closedInfo);
  });
  // Swallow errors — caller checks .closed for failure modes.
  ws.on('error', () => {
    /* ignore — observable via close */
  });

  return {
    ws,
    nextFrame() {
      if (queue.length > 0) return Promise.resolve(queue.shift() as Uint8Array);
      if (closedInfo) return Promise.resolve(null);
      return new Promise((resolve) => waiters.push(resolve));
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

// ---- Tests --------------------------------------------------------------

describe('ws upgrade auth', () => {
  it('rejects with 401 when token is missing', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}`);
    const closed = await d.closed;
    // Browser surfaces handshake-failure as ws code 1006 (abnormal). The
    // *HTTP* status was 401 — we asserted that path in the server logs; here
    // we just confirm the ws never opened.
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects with 401 when token is wrong', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=wrong-token-xxxxxxxxxxxxxxxxxxxxxxxxxxx`);
    const closed = await d.closed;
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
  });

  it('rejects with 403 when Origin is not in allowlist', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`, {
      Origin: 'http://evil.example.com',
    });
    const closed = await d.closed;
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
  });

  // T2 #675: Tauri 2 webview always sends `Origin: tauri://localhost`. The
  // daemon must whitelist that exact value (and nothing else under tauri:).
  it('accepts Origin: tauri://localhost (T2 #675)', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`, {
      Origin: 'tauri://localhost',
    });
    await waitOpen(d.ws);
    expect(d.ws.readyState).toBe(WebSocket.OPEN);
    d.ws.close();
  });

  it('rejects Origin: tauri://evil (only tauri://localhost is allow-listed)', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`, {
      Origin: 'tauri://evil',
    });
    const closed = await d.closed;
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
  });

  // S2 T2 (Task #727): ws upgrade must auto-inherit T1's classifyOrigin
  // allow-list for `https://cc-sm.pages.dev`. ws.mts calls
  // `classifyOrigin(origin)` and rejects on 'rejected'. After T1 (PR #1141)
  // the prod Pages host classifies as 'allowed', so the upgrade should yield
  // a 101 (ws OPEN) without any further change to ws.mts.
  it('accepts Origin: https://cc-sm.pages.dev (S2 T2 #727)', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`, {
      Origin: 'https://cc-sm.pages.dev',
    });
    await waitOpen(d.ws);
    expect(d.ws.readyState).toBe(WebSocket.OPEN);
    d.ws.close();
  });

  it('rejects Origin: https://cc-sm-evil.pages.dev (sibling spoof, S2 T2 #727)', async () => {
    // Defense-in-depth: confirm the ws path also rejects the spoof variant
    // that classifyOrigin marks 'rejected'. Without this we could regress
    // ws.mts independently of http.mts.
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`, {
      Origin: 'https://cc-sm-evil.pages.dev',
    });
    const closed = await d.closed;
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
  });

  // #672 regression: ws upgrade with NO Origin header must still succeed
  // (treated as same-origin). The `ws` Node client does NOT auto-add an
  // Origin header (unlike the browser API), so constructing a WebSocket
  // without any `headers` option produces a no-Origin upgrade.
  it('accepts ws upgrade with absent Origin (same-origin per #672)', async () => {
    const sid = await createSid();
    const ws = new WebSocket(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
      ws.once('close', (code) => reject(new Error(`closed before open: ${code}`)));
    });
    expect(ws.readyState).toBe(WebSocket.OPEN);
    ws.close();
  });

  it('rejects when sid is unknown (handshake refused)', async () => {
    const d = dial(`${baseWs}/ws?sid=this-sid-does-not-exist&token=${TOKEN}`);
    const closed = await d.closed;
    // Pre-handshake reject → ws sees abnormal close (1006). The server
    // wrote HTTP 404 to the socket, which `ws` does not surface as a code.
    expect(closed.code).toBeGreaterThanOrEqual(1000);
    expect(d.ws.readyState).toBe(WebSocket.CLOSED);
    // No PTY should have been spawned for the bogus sid.
    expect(ptyFactoryState.instances.length).toBe(0);
  });
});

describe('ws frame round-trip via fake PTY', () => {
  it('echoes INPUT -> pty.write, and OUTPUT -> ws.send', async () => {
    const sid = await createSid('C:/some/cwd');
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(d.ws);

    // Exactly one PTY should have been spawned for this sid.
    expect(ptyFactoryState.instances.length).toBe(1);
    const fpty = ptyFactoryState.instances[0]!;
    expect(fpty.spawnOpts.cwd).toBe('C:/some/cwd');
    expect(fpty.spawnOpts.cols).toBe(80);
    expect(fpty.spawnOpts.rows).toBe(24);

    // Client -> server: INPUT "hello"
    const inputPayload = Buffer.from('hello', 'utf8');
    d.ws.send(
      encodeFrame({
        type: FrameType.INPUT,
        seq: 1,
        payload: new Uint8Array(inputPayload.buffer, inputPayload.byteOffset, inputPayload.byteLength),
      }),
    );
    // Wait briefly for the server to process the INPUT.
    await new Promise((r) => setTimeout(r, 20));
    expect(fpty.written).toEqual(['hello']);

    // Simulate PTY echo: server should broadcast OUTPUT.
    fpty.emitData('hello\r\n');
    const out = await d.nextFrame();
    expect(out).not.toBeNull();
    const decoded = decodeFrame(out!);
    expect(decoded.type).toBe(FrameType.OUTPUT);
    expect(decoded.seq).toBe(1);
    expect(Buffer.from(decoded.payload).toString('utf8')).toBe('hello\r\n');

    d.ws.close();
  });

  it('forwards RESIZE -> pty.resize(cols, rows)', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(d.ws);
    const fpty = ptyFactoryState.instances[0]!;

    d.ws.send(
      encodeFrame({
        type: FrameType.RESIZE,
        seq: 2,
        payload: encodeResize(132, 50),
      }),
    );
    await new Promise((r) => setTimeout(r, 20));
    expect(fpty.lastResize).toEqual({ cols: 132, rows: 50 });

    d.ws.close();
  });

  it('emits EXIT frame and closes when PTY exits', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(d.ws);
    const fpty = ptyFactoryState.instances[0]!;

    fpty.emitExit(42);
    const f = await d.nextFrame();
    expect(f).not.toBeNull();
    const decoded = decodeFrame(f!);
    expect(decoded.type).toBe(FrameType.EXIT);
    expect(decodeExit(decoded.payload).code).toBe(42);
    const closed = await d.closed;
    expect(closed.code).toBe(1000);
  });

  it('kills PTY (SIGTERM) when last subscriber leaves', async () => {
    const sid = await createSid();
    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(d.ws);
    const fpty = ptyFactoryState.instances[0]!;

    d.ws.close();
    await d.closed;
    // Server cleanup runs on close event; give it a tick.
    await new Promise((r) => setTimeout(r, 20));
    // Task #758: kill signal is platform-specific. POSIX gets SIGTERM (with
    // a 200ms SIGKILL escalation backstop); Windows ignores signal names
    // (node-pty throws on them) and uses TerminateJobObject directly, which
    // we surface as a no-arg kill — the default ptyFactory adapter records
    // that as the literal string 'SIGKILL' for parity in tests.
    const expected = process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM';
    expect(fpty.killed).toContain(expected);
  });
});

// T#668: ws is now subscribe-only. A stub session row that has NO live
// runtime (e.g. survived a daemon restart, or never had POST /resume called)
// must not cause a spawn at upgrade time. Connecting closes the ws with
// code 1008 + 'session_not_spawned' so the frontend can branch to /resume.
describe('ws T#668: subscribe-only (no spawn on connect)', () => {
  it('closes with 1008 session_not_spawned for a stub with no runtime', async () => {
    // Seed a stub row directly (bypasses the POST /api/sessions path that
    // would spawn). Mimics the post-restart "row exists, runtime gone" state.
    const sid = 'stub-without-runtime-12345';
    http.sessions.set(sid, { sid, createdAt: Date.now(), alive: false, cwd: '/x' });
    const before = ptyFactoryState.instances.length;

    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    const closed = await d.closed;

    // ws sees the post-handshake close. Reason carries 'session_not_spawned'.
    expect(closed.reason).toBe('session_not_spawned');
    // Most importantly: NO PTY was spawned by the upgrade.
    expect(ptyFactoryState.instances.length).toBe(before);
  });

  it('forwards live OUTPUT to a subscriber once the session has been spawned via HTTP', async () => {
    // POST /api/sessions spawns; ws then subscribes and receives.
    const sid = await createSid('/work');
    expect(ptyFactoryState.instances.length).toBe(1);
    const fpty = ptyFactoryState.instances[0]!;
    expect(fpty.spawnOpts.sid).toBe(sid);
    expect(fpty.spawnOpts.mode).toBe('create');

    const d = dial(`${baseWs}/ws?sid=${sid}&token=${TOKEN}`);
    await waitOpen(d.ws);

    fpty.emitData('post-spawn-output');
    const out = await d.nextFrame();
    expect(out).not.toBeNull();
    const dec = decodeFrame(out!);
    expect(dec.type).toBe(FrameType.OUTPUT);
    expect(Buffer.from(dec.payload).toString('utf8')).toBe('post-spawn-output');

    d.ws.close();
    await d.closed;
  });
});
