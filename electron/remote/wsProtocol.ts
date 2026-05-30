import * as crypto from 'crypto';
import type { Duplex } from 'stream';

export type WsClient = {
  socket: Duplex;
  pending: Buffer;
  /** Accumulator for fragmented text messages (FIN=0). Reset on each
   *  complete message; non-empty means we're mid-fragment. */
  fragment: Buffer;
  /** The single session id this client is currently viewing, set when the
   *  client sends `session.snapshot` (the "select this session" signal).
   *  pty.data is only forwarded to clients whose `subscribedSid` matches the
   *  emitting sid — otherwise every client would receive every session's raw
   *  terminal bytes (cross-session data leak). `null` = not subscribed yet. */
  subscribedSid: string | null;
  send: (payload: unknown) => void;
};

/** Hard cap on a single inbound text message. Anything beyond this is a
 *  protocol violation or a buggy client; we close with 1009 rather than let
 *  Buffer.concat OOM the main process. 1 MiB is generous for our protocol
 *  (largest legitimate message is session.input, typically << 64 KiB). */
export const MAX_MESSAGE_BYTES = 1 << 20;

export function buildUpgradeResponse(key: string): string {
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

export function encodeFrame(payload: string): Buffer {
  return encodeFrameBytes(0x81, Buffer.from(payload, 'utf8'));
}

export function encodeControlFrame(opcode: number, payload: Buffer): Buffer {
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

export function closeSocket(socket: Duplex, code: number): void {
  // `writableEnded` guards re-entry: when the client streams a payload that
  // arrives in multiple TCP chunks, each chunk re-enters the 'data' handler
  // and may trip the same fatal limit again. Without this guard the second
  // call would `socket.end()` again, throw "write after end", and the catch
  // would `destroy()` the socket — losing the framed close payload we just
  // queued. Checking `writableEnded` keeps the first close frame intact.
  if (socket.destroyed || socket.writableEnded) return;
  const body = Buffer.allocUnsafe(2);
  body.writeUInt16BE(code, 0);
  try {
    // Use `end()` so the close frame is flushed before FIN. `destroy()` does
    // not wait for pending writes, so on Windows the framed close payload can
    // be dropped and the peer never sees the close reason.
    socket.end(encodeControlFrame(0x8, body));
  } catch {
    /* socket already gone */
    socket.destroy();
  }
}

export type DecodeResult =
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
export function decodeFrames(client: WsClient): DecodeResult {
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
