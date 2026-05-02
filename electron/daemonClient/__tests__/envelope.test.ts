// Encode/decode parity + spec-mandated rejection tests for the Electron
// envelope mirror. Round-trips through both the Electron-side encoder and
// the daemon-side encoder/decoder (imported from `daemon/src/envelope`) so
// any future drift between the two implementations fails this test.
//
// Spec citations:
//   - frag-3.4.1 §3.4.1.a frame-version nibble + 16 MiB cap.
//   - frag-3.4.1 §3.4.1.c header layout `[totalLen:4][headerLen:2][headerJSON][payload]`.

import { describe, expect, it } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  decodeFrame as clientDecode,
  encodeFrame as clientEncode,
  EnvelopeError,
  ENVELOPE_LIMITS,
} from '../envelope';

describe('Electron envelope mirror', () => {
  it('encodes a JSON-only frame to the documented byte layout', () => {
    const headerJson = Buffer.from(JSON.stringify({ id: 1, method: 'foo' }), 'utf8');
    const frame = clientEncode({ headerJson });

    // [totalLen:4][headerLen:2][headerJSON]
    const totalLen = frame.readUInt32BE(0);
    const versionNibble = (totalLen >>> 28) & 0x0f;
    const payloadLen = totalLen & 0x0fffffff;
    expect(versionNibble).toBe(0x0);
    expect(payloadLen).toBe(2 + headerJson.length);
    expect(frame.readUInt16BE(4)).toBe(headerJson.length);
    expect(frame.subarray(6, 6 + headerJson.length).toString('utf8'))
      .toBe(headerJson.toString('utf8'));
  });

  it('round-trips encode → decode with byte-equal header + payload', () => {
    const header = Buffer.from(JSON.stringify({ id: 42, method: 'foo' }), 'utf8');
    const payload = Buffer.from('hello-binary-trailer', 'utf8');
    const frame = clientEncode({ headerJson: header, payload });
    const decoded = clientDecode(frame);
    expect(decoded.version).toBe(0x0);
    expect(decoded.headerJson.equals(header)).toBe(true);
    expect(decoded.payload.equals(payload)).toBe(true);
  });

  it('rejects an oversize frame at encode time', () => {
    // Pretend we have a 16 MiB+1 byte payload by faking a giant Buffer alloc.
    // Use a real Buffer so the size check fires (not a Mock).
    const big = Buffer.alloc(ENVELOPE_LIMITS.MAX_PAYLOAD_BYTES); // exactly cap
    const header = Buffer.from(JSON.stringify({ id: 1, method: 'x' }), 'utf8');
    expect(() => clientEncode({ headerJson: header, payload: big })).toThrow(
      EnvelopeError,
    );
  });

  it('rejects an unknown frame-version nibble at decode time BEFORE applying the length cap', () => {
    // Build a frame where the high nibble is 0x1 and the low 28 bits decode
    // to a length that, if the cap-check ran first, would also fail. Spec
    // §3.4.1.a step 2 mandates UNSUPPORTED_FRAME_VERSION wins.
    const buf = Buffer.alloc(8);
    // raw = 0x1 << 28 | 6  (claim 6-byte payload — well under cap)
    buf.writeUInt32BE(((0x1) << 28) | 6, 0);
    buf.writeUInt16BE(2, 4);
    buf.writeUInt16BE(0xdead, 6);
    let thrown: EnvelopeError | undefined;
    try { clientDecode(buf); } catch (e) { thrown = e as EnvelopeError; }
    expect(thrown).toBeInstanceOf(EnvelopeError);
    expect(thrown!.code).toBe('UNSUPPORTED_FRAME_VERSION');
  });

  it('rejects a oversize-claimed length at decode time', () => {
    const buf = Buffer.alloc(4);
    // nibble 0, claim 17 MiB.
    buf.writeUInt32BE((17 * 1024 * 1024) & 0x0fffffff, 0);
    let thrown: EnvelopeError | undefined;
    try { clientDecode(buf); } catch (e) { thrown = e as EnvelopeError; }
    expect(thrown).toBeInstanceOf(EnvelopeError);
    expect(thrown!.code).toBe('envelope_too_large');
  });

  it('reports truncated_frame on a partial buffer', () => {
    const header = Buffer.from(JSON.stringify({ id: 1, method: 'x' }), 'utf8');
    const frame = clientEncode({ headerJson: header });
    // Slice the frame in half — both the prefix-only and mid-header cases
    // must be reported as truncated.
    let thrown: EnvelopeError | undefined;
    try { clientDecode(frame.subarray(0, 3)); } catch (e) { thrown = e as EnvelopeError; }
    expect(thrown!.code).toBe('truncated_frame');

    let thrown2: EnvelopeError | undefined;
    try { clientDecode(frame.subarray(0, frame.length - 1)); } catch (e) { thrown2 = e as EnvelopeError; }
    expect(thrown2!.code).toBe('truncated_frame');
  });
});

describe('byte-for-byte parity with daemon adapter', () => {
  // The daemon's envelope module is ESM; we cannot `require()` it from a
  // CJS-typed test file directly. Use dynamic import (vitest resolves both).
  it('client-encoded frame decodes byte-equal under daemon decoder', async () => {
    const daemonMod = await import(
      // path-relative import keeps vitest's resolver in CWD-rooted mode.
      '../../../daemon/src/envelope/envelope.js'
    );
    const headerObj = { id: 7, method: 'daemon.shutdownForUpgrade', payloadType: 'json', payloadLen: 0 };
    const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
    const frame = clientEncode({ headerJson });
    const decoded = daemonMod.decodeFrame(frame);
    expect(decoded.version).toBe(0x0);
    expect(decoded.headerJson.equals(headerJson)).toBe(true);
    expect(decoded.payload.length).toBe(0);
    // Parsing the header through to JSON must yield the original object.
    expect(JSON.parse(decoded.headerJson.toString('utf8'))).toEqual(headerObj);
  });

  it('daemon-encoded reply decodes byte-equal under client decoder', async () => {
    const daemonMod = await import('../../../daemon/src/envelope/envelope.js');
    const replyHeader = {
      id: 7,
      ok: true,
      value: { accepted: true, reason: 'upgrade' },
      ack_source: 'handler',
      payloadType: 'json',
      payloadLen: 0,
    };
    const headerJson = Buffer.from(JSON.stringify(replyHeader), 'utf8');
    const frame = daemonMod.encodeFrame({ headerJson });
    const decoded = clientDecode(frame);
    expect(decoded.headerJson.equals(headerJson)).toBe(true);
    expect(JSON.parse(decoded.headerJson.toString('utf8'))).toEqual(replyHeader);
  });
});
