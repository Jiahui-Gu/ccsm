// Sid envelope codec shared by daemon (Node) and cf-worker DO (Cloudflare
// Workers runtime).
//
// Wave-2 multi-tab routing (Task #105, R-41): the daemon and the DO share
// ONE tunnel ws but must fan out N concurrent browser↔PTY sessions over it.
// Every BINARY frame on the tunnel carries a small sid header so the
// receiving side can route into the correct per-sid PTY (daemon side) or
// per-sid browser ws (DO side). Control TEXT frames (hello / http_req /
// http_res) are unchanged and are never wrapped.
//
// Wire format (binary frames only):
//   byte 0:        sidLen (uint8, MUST be > 0 and <= ENVELOPE_MAX_SID_LEN)
//   bytes 1..N:    sid as utf8
//   bytes N+1..:   raw payload (the encoded INPUT / OUTPUT / RESIZE / EXIT
//                  frame produced by encodeFrame)
//
// 64-byte cap on sid is a sanity bound — real sids are short hex/base64url
// strings (~32 chars). A malformed envelope (sidLen=0, sidLen > cap, or
// sidLen exceeding the buffer) decodes to null; both sides drop with a warn
// log.
//
// R-48 (Task #160): single source of truth. Previously the daemon
// (packages/daemon/src/tunnel.mts) and the DO (packages/cf-worker/src/
// tunnel-do.ts) each kept their own copy. Wire-format drift here is a
// silent corruption bug (frames decode but route to the wrong sid), so the
// two implementations must NEVER diverge. Both call sites now import this
// module and `envelope.test.ts` proves they agree byte-for-byte.

/**
 * Sanity bound on sid length (utf8 bytes). Real ccsm sids are short
 * hex/base64url strings, well under 64 bytes. Frames whose sidLen header
 * exceeds this cap are dropped on the receive side.
 */
export const ENVELOPE_MAX_SID_LEN = 64;

/**
 * Encode `payload` with a leading sid header. Returns a fresh `Uint8Array`
 * — the caller does NOT need to copy. Throws when `sid` is empty or its
 * utf8 encoding exceeds {@link ENVELOPE_MAX_SID_LEN} (programmer error).
 *
 * Accepts both `Uint8Array` (DO / cf-worker) and Node `Buffer` (daemon) for
 * `payload`; `Buffer` is a `Uint8Array` subclass so `instanceof Uint8Array`
 * is true and no special-casing is needed. The returned `Uint8Array`
 * inter-operates with both runtimes — Node consumers can wrap it with
 * `Buffer.from(out.buffer, out.byteOffset, out.byteLength)` when a `Buffer`
 * is expected on the wire-send API.
 */
export function encodeSidEnvelope(
  sid: string,
  payload: Uint8Array,
): Uint8Array {
  const sidBytes = new TextEncoder().encode(sid);
  if (sidBytes.length === 0 || sidBytes.length > ENVELOPE_MAX_SID_LEN) {
    throw new Error(
      `encodeSidEnvelope: bad sid length ${sidBytes.length} (sid must be 1..${ENVELOPE_MAX_SID_LEN} utf8 bytes)`,
    );
  }
  const out = new Uint8Array(1 + sidBytes.length + payload.byteLength);
  out[0] = sidBytes.length;
  out.set(sidBytes, 1);
  out.set(payload, 1 + sidBytes.length);
  return out;
}

/**
 * Decode a sid-envelope buffer. Returns `null` when the buffer is too
 * short, has `sidLen === 0`, has `sidLen > ENVELOPE_MAX_SID_LEN`, or has
 * `sidLen` larger than the remaining bytes (malformed). Successful decodes
 * return `{ sid, payload }` where `payload` is a sub-array view into the
 * input — copy if you need to outlive the input.
 *
 * Accepts `Uint8Array` (DO) or anything `Uint8Array`-shaped (Node `Buffer`
 * is a `Uint8Array` subclass).
 */
export function decodeSidEnvelope(
  buf: Uint8Array,
): { sid: string; payload: Uint8Array } | null {
  if (buf.byteLength < 2) return null;
  const sidLen = buf[0] ?? 0;
  if (sidLen === 0 || sidLen > ENVELOPE_MAX_SID_LEN) return null;
  if (buf.byteLength < 1 + sidLen) return null;
  const sid = new TextDecoder().decode(buf.subarray(1, 1 + sidLen));
  const payload = buf.subarray(1 + sidLen);
  return { sid, payload };
}
