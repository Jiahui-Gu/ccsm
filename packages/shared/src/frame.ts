// Binary frame codec shared by daemon and frontend.
// Wire format (DESIGN.md §5):
//   +--------+--------+--------+--------+--------+
//   | type   |          seq (u32 BE)            | + payload (bytes)
//   |  1B    |             4B                   |
//   +--------+--------+--------+--------+--------+
//
// One WebSocket message == one frame. No streaming, no chunking at this layer.

export enum FrameType {
  OUTPUT = 0x01,
  INPUT = 0x02,
  RESIZE = 0x03,
  PAUSE = 0x04,
  RESUME = 0x05,
  RESET = 0x06,
  EXIT = 0x07,
}

export interface Frame {
  type: FrameType;
  seq: number;
  payload: Uint8Array;
}

const HEADER_BYTES = 5;
const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

const KNOWN_TYPES: ReadonlySet<number> = new Set([
  FrameType.OUTPUT,
  FrameType.INPUT,
  FrameType.RESIZE,
  FrameType.PAUSE,
  FrameType.RESUME,
  FrameType.RESET,
  FrameType.EXIT,
]);

export function encodeFrame(frame: Frame): Uint8Array {
  if (!Number.isInteger(frame.seq) || frame.seq < 0 || frame.seq > U32_MAX) {
    throw new RangeError(
      `seq out of u32 range: ${frame.seq} (expected integer in [0, ${U32_MAX}])`,
    );
  }
  if (!KNOWN_TYPES.has(frame.type)) {
    throw new RangeError(`unknown FrameType: 0x${frame.type.toString(16)}`);
  }
  const out = new Uint8Array(HEADER_BYTES + frame.payload.byteLength);
  const view = new DataView(out.buffer, out.byteOffset, out.byteLength);
  view.setUint8(0, frame.type);
  view.setUint32(1, frame.seq, false); // big-endian
  out.set(frame.payload, HEADER_BYTES);
  return out;
}

export function decodeFrame(buf: Uint8Array): Frame {
  if (buf.byteLength < HEADER_BYTES) {
    throw new RangeError(
      `frame too short: ${buf.byteLength} bytes (need >= ${HEADER_BYTES})`,
    );
  }
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const typeByte = view.getUint8(0);
  if (!KNOWN_TYPES.has(typeByte)) {
    throw new RangeError(`unknown FrameType byte: 0x${typeByte.toString(16)}`);
  }
  const seq = view.getUint32(1, false);
  // slice() copies; consumers can hold the payload independently of `buf`.
  const payload = buf.slice(HEADER_BYTES);
  return { type: typeByte as FrameType, seq, payload };
}

// ---- Typed payload helpers ----

export function encodeResize(cols: number, rows: number): Uint8Array {
  if (!Number.isInteger(cols) || cols < 0 || cols > U16_MAX) {
    throw new RangeError(
      `cols out of u16 range: ${cols} (expected integer in [0, ${U16_MAX}])`,
    );
  }
  if (!Number.isInteger(rows) || rows < 0 || rows > U16_MAX) {
    throw new RangeError(
      `rows out of u16 range: ${rows} (expected integer in [0, ${U16_MAX}])`,
    );
  }
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint16(0, cols, false);
  view.setUint16(2, rows, false);
  return out;
}

export function decodeResize(payload: Uint8Array): { cols: number; rows: number } {
  if (payload.byteLength !== 4) {
    throw new RangeError(
      `resize payload must be 4 bytes, got ${payload.byteLength}`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return {
    cols: view.getUint16(0, false),
    rows: view.getUint16(2, false),
  };
}

export function encodeExit(code: number): Uint8Array {
  // Spec: u32 BE. Negative codes (Node sometimes emits -1 for signal-killed
  // PTYs) are not representable in u32 — caller must normalize first.
  if (!Number.isInteger(code) || code < 0 || code > U32_MAX) {
    throw new RangeError(
      `exit code out of u32 range: ${code} (expected integer in [0, ${U32_MAX}])`,
    );
  }
  const out = new Uint8Array(4);
  const view = new DataView(out.buffer);
  view.setUint32(0, code, false);
  return out;
}

export function decodeExit(payload: Uint8Array): { code: number } {
  if (payload.byteLength !== 4) {
    throw new RangeError(
      `exit payload must be 4 bytes, got ${payload.byteLength}`,
    );
  }
  const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
  return { code: view.getUint32(0, false) };
}
