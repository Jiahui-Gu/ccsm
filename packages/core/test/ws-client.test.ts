import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  FrameType,
  decodeFrame,
  decodeResize,
  encodeExit,
  encodeFrame,
} from '@ccsm/shared';
import { WsClient, buildWsUrl, type HostBase } from '../src/ws/client.js';

const HOST: HostBase = { httpBase: 'http://127.0.0.1:17832' };

// Minimal browser WebSocket stub. Only the surface WsClient touches.
class MockWs {
  static OPEN = 1;
  static CLOSED = 3;
  readonly OPEN = MockWs.OPEN;
  readonly CLOSED = MockWs.CLOSED;
  readyState = 0;
  binaryType = '';
  sent: Uint8Array[] = [];
  closed = false;

  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    MockWs.lastInstance = this;
  }
  static lastInstance: MockWs | null = null;

  send(data: ArrayBufferView | ArrayBuffer): void {
    if (data instanceof Uint8Array) {
      // Copy so test assertions are stable even if WsClient ever reuses a buffer.
      this.sent.push(new Uint8Array(data));
      return;
    }
    if (data instanceof ArrayBuffer) {
      this.sent.push(new Uint8Array(data));
      return;
    }
    this.sent.push(
      new Uint8Array(data.buffer, data.byteOffset, data.byteLength),
    );
  }

  close(): void {
    this.closed = true;
    this.readyState = MockWs.CLOSED;
    this.onclose?.();
  }

  // Test helpers
  open(): void {
    this.readyState = MockWs.OPEN;
    this.onopen?.();
  }
  receive(buf: Uint8Array): void {
    this.onmessage?.({ data: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) });
  }
}

describe('buildWsUrl (hostBase injection)', () => {
  it('derives ws:// from http:// httpBase', () => {
    const url = buildWsUrl('s', 't', 0, { httpBase: 'http://127.0.0.1:17832' });
    expect(url).toBe('ws://127.0.0.1:17832/ws?sid=s&token=t');
  });

  it('derives wss:// from https:// httpBase', () => {
    const url = buildWsUrl('s', 't', 0, { httpBase: 'https://app.example.com' });
    expect(url).toBe('wss://app.example.com/ws?sid=s&token=t');
  });

  it('honours an explicit wsBase override', () => {
    const url = buildWsUrl('s', 't', 0, {
      httpBase: 'https://app.example.com',
      wsBase: 'ws://daemon.internal:9000',
    });
    expect(url).toBe('ws://daemon.internal:9000/ws?sid=s&token=t');
  });

  it('appends lastSeq only when > 0', () => {
    const u0 = buildWsUrl('s', 't', 0, HOST);
    expect(u0).not.toContain('lastSeq=');
    const u42 = buildWsUrl('s', 't', 42, HOST);
    expect(u42).toContain('lastSeq=42');
  });

  it('strips trailing slash on the origin to avoid `//ws`', () => {
    const url = buildWsUrl('s', 't', 0, { httpBase: 'http://127.0.0.1:17832/' });
    expect(url).toBe('ws://127.0.0.1:17832/ws?sid=s&token=t');
  });

  // Task #793 (S3-G): cloud-tunnel deployment must hit `/ws/default` so the
  // Pages Function + Worker route into the TunnelDO; literal `/ws` falls
  // through to the SPA index.html.
  it('honours an explicit wsPath override', () => {
    const url = buildWsUrl('s', 't', 0, {
      httpBase: 'https://cc-sm.pages.dev',
      wsPath: '/ws/default',
    });
    expect(url).toBe('wss://cc-sm.pages.dev/ws/default?sid=s&token=t');
  });

  it('falls back to API_PATHS.ws when wsPath is omitted', () => {
    const url = buildWsUrl('s', 't', 0, { httpBase: 'http://127.0.0.1:9876' });
    expect(url).toBe('ws://127.0.0.1:9876/ws?sid=s&token=t');
  });
});

describe('WsClient', () => {
  beforeEach(() => {
    MockWs.lastInstance = null;
  });

  it('encodes INPUT frames and writes them to the socket', () => {
    const client = new WsClient({
      sid: 'sid-1',
      token: 't0k',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    expect(ws.binaryType).toBe('arraybuffer');
    expect(ws.url).toMatch(/\/ws\?sid=sid-1&token=t0k$/);

    ws.open();
    client.sendInput('ls\n');
    expect(ws.sent.length).toBe(1);
    const frame = decodeFrame(ws.sent[0]!);
    expect(frame.type).toBe(FrameType.INPUT);
    expect(new TextDecoder().decode(frame.payload)).toBe('ls\n');
  });

  it('encodes RESIZE frames with cols/rows', () => {
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();
    client.sendResize(120, 40);
    expect(ws.sent.length).toBe(1);
    const frame = decodeFrame(ws.sent[0]!);
    expect(frame.type).toBe(FrameType.RESIZE);
    expect(decodeResize(frame.payload)).toEqual({ cols: 120, rows: 40 });
  });

  it('routes OUTPUT frames to onOutput', () => {
    const onOutput = vi.fn();
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
      onOutput,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();

    const payload = new TextEncoder().encode('hello world');
    const frame = encodeFrame({ type: FrameType.OUTPUT, seq: 1, payload });
    ws.receive(frame);

    expect(onOutput).toHaveBeenCalledTimes(1);
    const got = onOutput.mock.calls[0]![0] as Uint8Array;
    expect(new TextDecoder().decode(got)).toBe('hello world');
  });

  it('handles EXIT frames: fires onExit, closes socket, sets exited status', () => {
    const onExit = vi.fn();
    const onDisconnect = vi.fn();
    const onStatus = vi.fn();
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
      onExit,
      onDisconnect,
      onStatusChange: onStatus,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();

    const exitPayload = encodeExit(0);
    const frame = encodeFrame({ type: FrameType.EXIT, seq: 42, payload: exitPayload });
    ws.receive(frame);

    expect(onExit).toHaveBeenCalledWith(0);
    expect(client.getStatus()).toBe('exited');
    expect(ws.closed).toBe(true);
    // EXIT must NOT also emit a generic disconnect notice.
    expect(onDisconnect).not.toHaveBeenCalled();
    expect(onStatus).toHaveBeenCalledWith('exited');
  });

  it('reports disconnect when socket closes without an EXIT frame', () => {
    const onDisconnect = vi.fn();
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
      onDisconnect,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();
    ws.onclose?.();
    expect(onDisconnect).toHaveBeenCalledWith('ws closed');
    expect(client.getStatus()).toBe('disconnected');
  });

  it('sendInput is a no-op before the socket opens', () => {
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    // readyState is still 0 (CONNECTING) — no send should happen.
    client.sendInput('x');
    expect(MockWs.lastInstance!.sent.length).toBe(0);
  });

  it('buffers a RESIZE issued before OPEN and flushes it on onopen', () => {
    // Regression: the very first sendResize from MainPane fires synchronously
    // after connect() while readyState is still CONNECTING. Previously it was
    // silently dropped, leaving the daemon PTY at node-pty's default 80x24.
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    // Pre-open: size is buffered, not sent.
    client.sendResize(140, 50);
    expect(ws.sent.length).toBe(0);

    // Latest size wins if multiple resizes arrive before OPEN.
    client.sendResize(160, 60);
    expect(ws.sent.length).toBe(0);

    ws.open();
    expect(ws.sent.length).toBe(1);
    const frame = decodeFrame(ws.sent[0]!);
    expect(frame.type).toBe(FrameType.RESIZE);
    expect(decodeResize(frame.payload)).toEqual({ cols: 160, rows: 60 });

    // Subsequent resizes go straight through and the buffer does not re-fire.
    client.sendResize(170, 70);
    expect(ws.sent.length).toBe(2);
  });

  // ---- T10 (#662) carry-over ----

  it('appends ?lastSeq=<n> to the ws URL when the option is > 0', () => {
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      lastSeq: 42,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    expect(ws.url).toContain('lastSeq=42');
  });

  it('omits lastSeq from the URL when 0 (matches daemon "missing == 0" convention)', () => {
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      lastSeq: 0,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
    });
    client.connect();
    expect(MockWs.lastInstance!.url).not.toContain('lastSeq=');
  });

  it('routes RESET frames to onReset with the seq baseline', () => {
    const onReset = vi.fn();
    const onOutput = vi.fn();
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
      onReset,
      onOutput,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();
    const frame = encodeFrame({
      type: FrameType.RESET,
      seq: 123,
      payload: new Uint8Array(0),
    });
    ws.receive(frame);
    expect(onReset).toHaveBeenCalledWith(123);
    expect(onOutput).not.toHaveBeenCalled();
  });

  it('forwards OUTPUT seq alongside the payload (carry-over for lastSeq merge)', () => {
    const onOutput = vi.fn();
    const client = new WsClient({
      sid: 's',
      token: 't',
      hostBase: HOST,
      WebSocketImpl: MockWs as unknown as typeof WebSocket,
      onOutput,
    });
    client.connect();
    const ws = MockWs.lastInstance!;
    ws.open();
    const payload = new TextEncoder().encode('chunk');
    ws.receive(encodeFrame({ type: FrameType.OUTPUT, seq: 99, payload }));
    expect(onOutput).toHaveBeenCalledTimes(1);
    const [data, seq] = onOutput.mock.calls[0]!;
    expect(new TextDecoder().decode(data as Uint8Array)).toBe('chunk');
    expect(seq).toBe(99);
  });
});
