// Chunk reassembly for stream sub-frames (spec §3.4.1.b).
//
// The wire layer chunks any stream-message payload larger than 16 KiB into
// N ≤16 KiB sub-frames sharing the same `streamId` and a per-stream monotonic
// `seq`. Receivers reassemble the original logical message by `streamId`. This
// module is the pure state machine for that reassembly: it owns sequence
// validation, the bounded replay buffer used for resubscribe support, and the
// final-flag-driven message materialization. It does NOT touch sockets, HMACs,
// or the envelope encode/decode path (`envelope.ts` owns that).
//
// Key invariants enforced (spec §3.4.1.b + Task 5 step-4 chunking bullet):
//   1. Sub-frame payload is ≤ MAX_SUBFRAME_BYTES (16 KiB). Larger payloads are
//      a producer bug; reject so the bug is loud, not silent corruption.
//   2. `seq` is strictly monotonically increasing per stream, starting at 0
//      (or whatever `firstSeq` was passed at construction). No jumps, no
//      duplicates, no out-of-order delivery — the underlying socket is
//      byte-serialized FIFO so any gap signals corruption or a missed frame.
//   3. The replay buffer is bounded at MAX_REPLAY_BYTES (256 KiB total bytes
//      across retained chunk payloads). When a new chunk would push the total
//      over the cap, the OLDEST retained chunks are evicted FIFO until the
//      budget fits. A consumer requesting a `fromSeq` older than the oldest
//      retained chunk is the trigger for the daemon to emit `gap: true` +
//      snapshot (that policy lives in the adapter; here we only expose the
//      window via `getReplayWindow`).
//
// This module deliberately does NOT validate `kind` against the spec enum
// (`"open" | "chunk" | "close" | "heartbeat"`); kind discrimination is the
// adapter's job (heartbeats don't carry payload, opens carry no chunk seq).
// We only see `chunk`-kind sub-frames and the `final` flag that closes a
// logical message. `final` is the API surface the task description asks for;
// at the wire level it is implied when the next frame on `streamId` is the
// `kind: "close"` frame OR when the producer flushes a logical message
// boundary. Either way the adapter sets `final: true` on the last sub-frame
// of a logical message before handing to this reassembler.

import { Buffer } from 'node:buffer';

/** ≤16 KiB per sub-frame payload — spec §3.4.1.b. */
export const MAX_SUBFRAME_BYTES = 16 * 1024;

/** ≤256 KiB total replay-buffer bytes per stream — spec §3.4.1.b replay bound. */
export const MAX_REPLAY_BYTES = 256 * 1024;

/**
 * One retained sub-frame in the replay buffer. The original `payload` is held
 * by reference (zero-copy); callers MUST treat it as immutable.
 */
export interface ReplayEntry {
  readonly seq: number;
  readonly payload: Buffer;
}

/** Header fields the reassembler reads off each incoming sub-frame. */
export interface ChunkHeader {
  readonly streamId: string;
  readonly seq: number;
  /** True on the last sub-frame of a logical message. */
  readonly final?: boolean;
}

/**
 * Per-stream reassembly state. Constructed lazily on first sub-frame for a
 * `streamId`. `lastSeq` starts at -1 so the first accepted seq is 0 (matches
 * spec wording "per-stream monotonic seq" without baking in a 1-based
 * convention).
 */
export interface StreamState {
  readonly streamId: string;
  /** Highest `seq` accepted on this stream, or -1 if none yet. */
  lastSeq: number;
  /** Sub-frames held for the in-progress logical message (cleared on `final`). */
  pending: Buffer[];
  /** Total bytes currently held in `replay` (sum of `replay[i].payload.length`). */
  replayBytes: number;
  /** FIFO replay buffer for resubscribe support; evicted oldest-first at cap. */
  replay: ReplayEntry[];
}

/**
 * Result of `acceptChunk`. Exactly one of `error` or (optionally) `message`
 * is meaningful per call:
 *   - `error` set → the sub-frame was rejected; stream state is UNCHANGED.
 *   - `complete: true` + `message` set → `final` flag closed a logical
 *      message; `message` is the concatenated payload bytes.
 *   - `complete: false` → sub-frame accepted into pending; no message yet.
 */
export interface AcceptResult {
  readonly complete: boolean;
  readonly message?: Buffer;
  readonly error?: string;
}

const newState = (streamId: string): StreamState => ({
  streamId,
  lastSeq: -1,
  pending: [],
  replayBytes: 0,
  replay: [],
});

/**
 * Pure (state-mutating) accept of one sub-frame. Returns success/error result
 * without throwing — the adapter classifies `error` strings into the right
 * wire-level RPC error code (`RESOURCE_EXHAUSTED`, `seq_jump`, etc.).
 *
 * Errors leave `state` UNCHANGED so a recoverable adapter could reject the
 * frame, log, and keep the stream open if the policy ever changes. Today's
 * policy (per spec §3.4.1.a oversize handling) is to log + destroy the socket;
 * we keep the no-mutate-on-error contract anyway because it makes unit tests
 * deterministic.
 */
export function acceptChunk(
  state: StreamState,
  header: ChunkHeader,
  payload: Buffer,
): AcceptResult {
  if (header.streamId !== state.streamId) {
    return { complete: false, error: `streamId mismatch: state=${state.streamId} header=${header.streamId}` };
  }
  if (payload.length > MAX_SUBFRAME_BYTES) {
    return {
      complete: false,
      error: `sub-frame payload ${payload.length} exceeds ${MAX_SUBFRAME_BYTES}`,
    };
  }
  if (!Number.isInteger(header.seq) || header.seq < 0) {
    return { complete: false, error: `invalid seq ${String(header.seq)}` };
  }
  const expected = state.lastSeq + 1;
  if (header.seq !== expected) {
    return {
      complete: false,
      error: `seq out of order: expected ${expected} got ${header.seq}`,
    };
  }

  // Accept: append to pending + replay; advance lastSeq.
  state.pending.push(payload);
  state.lastSeq = header.seq;
  state.replay.push({ seq: header.seq, payload });
  state.replayBytes += payload.length;

  // Evict oldest replay entries until we fit under the cap. Per spec the
  // adapter is what emits `gap: true` when a consumer asks for a seq older
  // than what survived eviction; here we just hold the bound.
  while (state.replayBytes > MAX_REPLAY_BYTES && state.replay.length > 0) {
    const dropped = state.replay.shift();
    if (dropped === undefined) break;
    state.replayBytes -= dropped.payload.length;
  }

  if (header.final === true) {
    const assembled = Buffer.concat(state.pending);
    state.pending = [];
    return { complete: true, message: assembled };
  }
  return { complete: false };
}

/**
 * `ChunkReassembler` is a thin convenience wrapper over the pure functions
 * for the common adapter use-case where a single instance owns many streams
 * keyed by `streamId`. Adapters that prefer to manage their own per-stream
 * `StreamState` map (e.g. for sharded locking) can skip the class entirely
 * and call `acceptChunk` directly.
 */
export class ChunkReassembler {
  private readonly streams = new Map<string, StreamState>();

  /**
   * Reset / discard a stream's state — called on `kind: "close"`, on a
   * fatal error, or when the supervisor notifies us the producer is gone.
   */
  forget(streamId: string): void {
    this.streams.delete(streamId);
  }

  /**
   * Accept one sub-frame. Allocates the per-stream state lazily on the first
   * frame we see for a streamId.
   */
  accept(header: ChunkHeader, payload: Buffer): AcceptResult {
    let state = this.streams.get(header.streamId);
    if (state === undefined) {
      // First frame on this stream MUST be seq 0; reject jumps at open too,
      // not just mid-stream, so resubscribe-from-mid-seq is an explicit
      // adapter-level operation (it loads a snapshot first, then issues a
      // fresh subscribe at seq 0).
      if (header.seq !== 0) {
        return {
          complete: false,
          error: `first frame on streamId=${header.streamId} must be seq 0, got ${header.seq}`,
        };
      }
      state = newState(header.streamId);
      this.streams.set(header.streamId, state);
    }
    return acceptChunk(state, header, payload);
  }

  /**
   * Snapshot of the current replay buffer for `streamId`, ordered oldest →
   * newest. Returns an empty array if the stream is unknown. The returned
   * array is a fresh copy; mutating it does not affect internal state.
   * Buffer payloads are NOT copied (zero-copy view by reference).
   */
  getReplayWindow(streamId: string): ReplayEntry[] {
    const state = this.streams.get(streamId);
    if (state === undefined) return [];
    return state.replay.slice();
  }

  /**
   * Total replay bytes currently held for `streamId`. Useful for tests + the
   * adapter's `gap: true` decision when a `fromSeq` request arrives.
   */
  getReplayBytes(streamId: string): number {
    return this.streams.get(streamId)?.replayBytes ?? 0;
  }

  /** Highest seq accepted on `streamId`, or -1 if unknown. */
  getLastSeq(streamId: string): number {
    return this.streams.get(streamId)?.lastSeq ?? -1;
  }
}

export const CHUNK_LIMITS = Object.freeze({
  MAX_SUBFRAME_BYTES,
  MAX_REPLAY_BYTES,
});
