import * as crypto from 'crypto';
import * as http from 'http';
import type { Duplex } from 'stream';
import {
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  listPtySessions,
  onPtyData,
} from '../ptyHost';

type MobileRemoteServer = {
  close: () => void;
};

type WsClient = {
  socket: Duplex;
  pending: Buffer;
  /** Accumulator for fragmented text messages (FIN=0). Reset on each
   *  complete message; non-empty means we're mid-fragment. */
  fragment: Buffer;
  send: (payload: unknown) => void;
};

const DEFAULT_PORT = 4177;
const HOST = '127.0.0.1';
/** Hard cap on a single inbound text message. Anything beyond this is a
 *  protocol violation or a buggy client; we close with 1009 rather than let
 *  Buffer.concat OOM the main process. 1 MiB is generous for our protocol
 *  (largest legitimate message is session.input, typically << 64 KiB). */
const MAX_MESSAGE_BYTES = 1 << 20;

export function startMobileRemoteServer(): MobileRemoteServer | null {
  if (process.env.CCSM_MOBILE_REMOTE !== '1') return null;

  const token = crypto.randomBytes(32).toString('base64url');
  const port = resolvePort(process.env.CCSM_MOBILE_REMOTE_PORT);
  const clients = new Set<WsClient>();
  const seqBySid = new Map<string, number>();

  const server = http.createServer((req, res) => {
    const url = parseRequestUrl(req.url);
    if (!url) {
      sendText(res, 400, 'Bad request');
      return;
    }

    if (url.pathname === '/') {
      if (url.searchParams.get('token') !== token) {
        sendText(res, 401, 'Unauthorized');
        return;
      }
      sendHtml(res, renderMobilePage());
      return;
    }

    sendText(res, 404, 'Not found');
  });

  server.on('upgrade', (req, socket) => {
    const url = parseRequestUrl(req.url);
    if (!url || url.pathname !== '/ws' || url.searchParams.get('token') !== token) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }

    const key = req.headers['sec-websocket-key'];
    if (typeof key !== 'string') {
      socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
      socket.destroy();
      return;
    }

    socket.write(buildUpgradeResponse(key));
    const client: WsClient = {
      socket,
      pending: Buffer.alloc(0),
      fragment: Buffer.alloc(0),
      send: (payload) => {
        if (socket.destroyed) return;
        socket.write(encodeFrame(JSON.stringify(payload)));
      },
    };
    clients.add(client);
    client.send({ type: 'auth.ok' });
    client.send({ type: 'sessions.list', sessions: listPtySessions() });

    socket.on('data', (chunk) => {
      client.pending = Buffer.concat([client.pending, chunk]);
      const decoded = decodeFrames(client);
      if (decoded.kind === 'fatal') {
        closeSocket(socket, decoded.code);
        clients.delete(client);
        return;
      }
      for (const message of decoded.messages) {
        void handleClientMessage(client, message);
      }
      for (const pong of decoded.pongs) {
        if (!socket.destroyed) socket.write(encodeControlFrame(0xa, pong));
      }
      if (decoded.close) {
        closeSocket(socket, 1000);
        clients.delete(client);
      }
    });
    socket.on('close', () => clients.delete(client));
    socket.on('error', () => clients.delete(client));
  });

  const offPtyData = onPtyData((sid, chunk) => {
    const seq = (seqBySid.get(sid) ?? 0) + 1;
    seqBySid.set(sid, seq);
    for (const client of clients) {
      client.send({ type: 'pty.data', sid, chunk, seq });
    }
  });

  server.listen(port, HOST, () => {
    console.log(`[mobile-remote] listening at http://${HOST}:${port}/?token=${token}`);
    console.log(`[mobile-remote] tailscale: tailscale serve --bg http://${HOST}:${port}`);
  });

  server.on('error', (err) => {
    console.error('[mobile-remote] server error:', err);
  });

  return {
    close: () => {
      offPtyData();
      for (const client of clients) client.socket.destroy();
      clients.clear();
      server.close();
    },
  };
}

async function handleClientMessage(client: WsClient, raw: string): Promise<void> {
  let message: unknown;
  try {
    message = JSON.parse(raw);
  } catch {
    client.send({ type: 'error', message: 'invalid_json' });
    return;
  }

  if (!isRecord(message) || typeof message.type !== 'string') {
    client.send({ type: 'error', message: 'invalid_message' });
    return;
  }

  if (message.type === 'sessions.list') {
    client.send({ type: 'sessions.list', sessions: listPtySessions() });
    return;
  }

  if (message.type === 'session.snapshot') {
    if (typeof message.sid !== 'string') {
      client.send({ type: 'error', message: 'missing_sid' });
      return;
    }
    const snapshot = await getBufferSnapshot(message.sid);
    const info = getPtySession(message.sid);
    client.send({
      type: 'session.snapshot',
      sid: message.sid,
      cols: info?.cols ?? null,
      rows: info?.rows ?? null,
      ...snapshot,
    });
    return;
  }

  if (message.type === 'session.input') {
    if (typeof message.sid !== 'string' || typeof message.data !== 'string') {
      client.send({ type: 'error', message: 'invalid_input' });
      return;
    }
    inputPtySession(message.sid, message.data);
    return;
  }

  client.send({ type: 'error', message: 'unknown_type' });
}

function resolvePort(raw: string | undefined): number {
  if (!raw) return DEFAULT_PORT;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) return DEFAULT_PORT;
  return parsed;
}

function parseRequestUrl(raw: string | undefined): URL | null {
  if (!raw) return null;
  try {
    return new URL(raw, `http://${HOST}`);
  } catch {
    return null;
  }
}

function sendHtml(res: http.ServerResponse, body: string): void {
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function sendText(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(body);
}

function buildUpgradeResponse(key: string): string {
  const accept = crypto
    .createHash('sha1')
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  return [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${accept}`,
    '',
    '',
  ].join('\r\n');
}

function encodeFrame(payload: string): Buffer {
  return encodeFrameBytes(0x81, Buffer.from(payload, 'utf8'));
}

function encodeControlFrame(opcode: number, payload: Buffer): Buffer {
  return encodeFrameBytes(0x80 | (opcode & 0x0f), payload);
}

function encodeFrameBytes(firstByte: number, body: Buffer): Buffer {
  if (body.length < 126) {
    return Buffer.concat([Buffer.from([firstByte, body.length]), body]);
  }
  if (body.length <= 0xffff) {
    const header = Buffer.allocUnsafe(4);
    header[0] = firstByte;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
    return Buffer.concat([header, body]);
  }
  const header = Buffer.allocUnsafe(10);
  header[0] = firstByte;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(body.length), 2);
  return Buffer.concat([header, body]);
}

function closeSocket(socket: Duplex, code: number): void {
  if (socket.destroyed) return;
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(code, 0);
  try {
    socket.write(encodeControlFrame(0x8, body));
  } catch {
    /* socket already gone */
  }
  socket.destroy();
}

type DecodeResult =
  | {
      kind: 'ok';
      messages: string[];
      pongs: Buffer[];
      close: boolean;
    }
  | { kind: 'fatal'; code: number };

/**
 * Stateful WebSocket frame decoder. Mutates `client.pending` and
 * `client.fragment`:
 *   - `pending` keeps partially-arrived frame bytes between data events.
 *   - `fragment` accumulates text fragments across FIN=0 frames.
 *
 * Returns either a batch of complete text messages + Ping payloads to Pong,
 * or a fatal protocol-violation code that the caller should Close with.
 */
function decodeFrames(client: WsClient): DecodeResult {
  const messages: string[] = [];
  const pongs: Buffer[] = [];
  let close = false;
  let buffer = client.pending;
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const frameStart = offset;
    const first = buffer[offset]!;
    const second = buffer[offset + 1]!;
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    offset += 2;

    if (rsv !== 0) return { kind: 'fatal', code: 1002 };

    if (length === 126) {
      if (offset + 2 > buffer.length) {
        client.pending = buffer.subarray(frameStart);
        return { kind: 'ok', messages, pongs, close };
      }
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) {
        client.pending = buffer.subarray(frameStart);
        return { kind: 'ok', messages, pongs, close };
      }
      const big = buffer.readBigUInt64BE(offset);
      if (big > BigInt(MAX_MESSAGE_BYTES)) return { kind: 'fatal', code: 1009 };
      length = Number(big);
      offset += 8;
    }

    if (!masked) return { kind: 'fatal', code: 1002 };
    if (length > MAX_MESSAGE_BYTES) return { kind: 'fatal', code: 1009 };

    const isControl = (opcode & 0x8) !== 0;
    if (isControl && (!fin || length > 125)) return { kind: 'fatal', code: 1002 };

    if (offset + 4 + length > buffer.length) {
      client.pending = buffer.subarray(frameStart);
      return { kind: 'ok', messages, pongs, close };
    }
    const mask = buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = unmask(buffer.subarray(offset, offset + length), mask);
    offset += length;

    if (opcode === 0x8) {
      close = true;
      break;
    }
    if (opcode === 0x9) {
      pongs.push(payload);
      continue;
    }
    if (opcode === 0xa) {
      // Pong reply to our (currently nonexistent) Pings — ignore.
      continue;
    }

    // Data frames: 0x0 continuation, 0x1 text, 0x2 binary.
    if (opcode === 0x2) return { kind: 'fatal', code: 1003 };
    if (opcode === 0x1) {
      if (client.fragment.length > 0) return { kind: 'fatal', code: 1002 };
      if (fin) {
        messages.push(payload.toString('utf8'));
      } else {
        if (payload.length > MAX_MESSAGE_BYTES) return { kind: 'fatal', code: 1009 };
        client.fragment = payload;
      }
      continue;
    }
    if (opcode === 0x0) {
      if (client.fragment.length === 0) return { kind: 'fatal', code: 1002 };
      const next = Buffer.concat([client.fragment, payload]);
      if (next.length > MAX_MESSAGE_BYTES) return { kind: 'fatal', code: 1009 };
      client.fragment = next;
      if (fin) {
        messages.push(client.fragment.toString('utf8'));
        client.fragment = Buffer.alloc(0);
      }
      continue;
    }
    return { kind: 'fatal', code: 1002 };
  }

  client.pending = buffer.subarray(offset);
  return { kind: 'ok', messages, pongs, close };
}

function unmask(payload: Buffer, mask: Buffer): Buffer {
  const out = Buffer.allocUnsafe(payload.length);
  for (let i = 0; i < payload.length; i += 1) {
    out[i] = payload[i]! ^ mask[i % 4]!;
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function renderMobilePage(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>CCSM Mobile Remote</title>
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css" />
  <style>
    * { box-sizing: border-box; }
    html, body { margin: 0; height: 100%; background: #0b1020; color: #e5e7eb; font: 14px system-ui, sans-serif; }
    body { display: flex; flex-direction: column; }
    header { padding: 10px 12px; background: #111827; border-bottom: 1px solid #263042; }
    #sessions { display: flex; gap: 8px; overflow-x: auto; padding: 8px 12px; background: #0f172a; border-bottom: 1px solid #1f2937; }
    #sessions button { flex: 0 0 auto; border: 1px solid #374151; border-radius: 10px; background: #1f2937; color: #e5e7eb; padding: 8px 12px; font: inherit; }
    #sessions button.active { border-color: #60a5fa; background: #1e3a8a; }
    #terminal { flex: 1; min-height: 0; background: #000; padding: 6px; overflow: auto; }
    #terminal .xterm { height: 100% !important; }
    .muted { color: #9ca3af; }
  </style>
</head>
<body>
  <header>
    <strong>CCSM Mobile Remote</strong>
    <span id="status" class="muted"> · Connecting...</span>
  </header>
  <div id="sessions"><span class="muted">Loading sessions...</span></div>
  <div id="terminal"></div>
  <script src="https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"></script>
  <script>
    const token = new URLSearchParams(location.search).get('token') || '';
    const statusEl = document.getElementById('status');
    const sessionsEl = document.getElementById('sessions');
    const terminalEl = document.getElementById('terminal');
    const term = new window.Terminal({
      convertEol: false,
      disableStdin: false,
      cursorBlink: true,
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#000000' },
      scrollback: 5000,
      cols: 120,
      rows: 30,
    });
    term.open(terminalEl);
    term.onData((data) => {
      if (!activeSid) return;
      send({ type: 'session.input', sid: activeSid, data });
    });

    let activeSid = '';
    let sessions = [];
    let lastCols = 0;
    let lastRows = 0;
    const wsUrl = new URL('/ws', location.href);
    wsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    wsUrl.searchParams.set('token', token);
    const ws = new WebSocket(wsUrl);

    ws.onopen = () => { statusEl.textContent = ' · Connected'; };
    ws.onclose = () => { statusEl.textContent = ' · Disconnected'; };
    ws.onerror = () => { statusEl.textContent = ' · Connection error'; };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'sessions.list') {
        sessions = msg.sessions || [];
        renderSessions();
        if (!activeSid && sessions.length) selectSession(sessions[0].sid);
        return;
      }
      if (msg.type === 'session.snapshot' && msg.sid === activeSid) {
        applySize(msg.cols, msg.rows);
        term.reset();
        term.write(msg.snapshot || '');
        return;
      }
      if (msg.type === 'pty.data' && msg.sid === activeSid) {
        term.write(msg.chunk || '');
        return;
      }
    };

    function applySize(cols, rows) {
      const c = Number.isInteger(cols) && cols > 0 ? cols : lastCols || 120;
      const r = Number.isInteger(rows) && rows > 0 ? rows : lastRows || 30;
      if (c === lastCols && r === lastRows) return;
      lastCols = c;
      lastRows = r;
      try { term.resize(c, r); } catch {}
    }

    function send(msg) {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    }
    function selectSession(sid) {
      activeSid = sid;
      renderSessions();
      term.reset();
      send({ type: 'session.snapshot', sid });
    }
    function renderSessions() {
      sessionsEl.textContent = '';
      if (!sessions.length) {
        const span = document.createElement('span');
        span.className = 'muted';
        span.textContent = 'No live PTY sessions. Open a CCSM session on desktop first.';
        sessionsEl.appendChild(span);
        return;
      }
      for (const session of sessions) {
        const btn = document.createElement('button');
        btn.textContent = session.sid.slice(0, 8);
        btn.className = session.sid === activeSid ? 'active' : '';
        btn.onclick = () => selectSession(session.sid);
        sessionsEl.appendChild(btn);
      }
    }
  </script>
</body>
</html>`;
}
