// Per-session ring buffer for PTY output replay (DESIGN.md §3, F4, F6).
//
// Design:
//   - Fixed-capacity (RING_BYTES) circular byte buffer.
//   - Per-frame index entries { seq, byteOffset, byteLength } recording where
//     each appended chunk lives in the underlying Uint8Array. Entries are
//     evicted FIFO when capacity pressure requires it.
//   - `range(fromSeq, toSeq)` returns the concatenated bytes of all frames
//     whose seq is in [fromSeq, toSeq] inclusive, or null if `fromSeq` is no
//     longer in the index (already evicted, caller should send RESET).
//   - Wrap-around handled by reading the underlying buffer in up-to-two slices.
//
// Limits:
//   - A single frame larger than RING_BYTES is rejected (returns false from
//     `append`). PTY chunks in practice are far below this.
//   - This buffer stores raw bytes only; framing/encoding is the caller's job.

export const RING_BYTES = 4 * 1024 * 1024;

interface FrameIndex {
  seq: number;
  byteOffset: number;
  byteLength: number;
}

export class RingBuffer {
  readonly capacity: number;
  private readonly buf: Uint8Array;
  private writeOffset = 0;
  private readonly index: FrameIndex[] = [];
  private bytesUsed = 0;

  constructor(capacity: number = RING_BYTES) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.buf = new Uint8Array(capacity);
  }

  /** seq of the oldest retained frame, or null if empty. */
  get firstSeq(): number | null {
    return this.index.length === 0 ? null : this.index[0]!.seq;
  }

  /** seq of the most recently appended frame, or null if empty. */
  get lastSeq(): number | null {
    return this.index.length === 0 ? null : this.index[this.index.length - 1]!.seq;
  }

  /** Total bytes currently retained across all frames in the index. */
  get byteLength(): number {
    return this.bytesUsed;
  }

  /** Number of frames currently retained (test/debug helper). */
  get frameCount(): number {
    return this.index.length;
  }

  /**
   * Append a frame. Evicts oldest entries as needed. Returns true on success,
   * false if the frame is larger than capacity (cannot fit even after eviction).
   */
  append(seq: number, bytes: Uint8Array): boolean {
    if (!Number.isInteger(seq) || seq < 0) {
      throw new RangeError(`seq must be a non-negative integer, got ${seq}`);
    }
    const len = bytes.byteLength;
    if (len === 0) {
      // Record a zero-length frame so range() can see the seq exists; but it
      // contributes nothing to bytesUsed and we don't advance writeOffset.
      this.index.push({ seq, byteOffset: this.writeOffset, byteLength: 0 });
      return true;
    }
    if (len > this.capacity) {
      // Single frame doesn't fit. Reject — caller should treat as evicted.
      return false;
    }

    // Evict from the front until there's enough room.
    while (this.bytesUsed + len > this.capacity) {
      const evicted = this.index.shift();
      if (!evicted) break; // shouldn't happen; loop guard.
      this.bytesUsed -= evicted.byteLength;
    }

    // Write bytes, possibly wrapping.
    const startOffset = this.writeOffset;
    const tail = this.capacity - startOffset;
    if (len <= tail) {
      this.buf.set(bytes, startOffset);
    } else {
      this.buf.set(bytes.subarray(0, tail), startOffset);
      this.buf.set(bytes.subarray(tail), 0);
    }
    this.writeOffset = (startOffset + len) % this.capacity;
    this.bytesUsed += len;
    this.index.push({ seq, byteOffset: startOffset, byteLength: len });
    return true;
  }

  /**
   * Return the concatenated bytes of all frames with seq in [fromSeq, toSeq].
   * Returns null if `fromSeq` has been evicted (i.e., not present in the index
   * AND older than firstSeq), signaling the caller should send RESET.
   *
   * If fromSeq > lastSeq the result is an empty Uint8Array (caller-up-to-date).
   * If toSeq < fromSeq the result is an empty Uint8Array.
   */
  range(fromSeq: number, toSeq: number): Uint8Array | null {
    if (this.index.length === 0) {
      // Nothing buffered. If caller asks for fromSeq=0 (fresh) treat as empty
      // (no replay needed). Anything else they ask for is "we don't have it",
      // but with no history we can't say it was evicted vs never existed.
      // Convention: return empty so a fresh client doesn't get a spurious RESET.
      return fromSeq === 0 ? new Uint8Array(0) : new Uint8Array(0);
    }
    const first = this.index[0]!.seq;
    const last = this.index[this.index.length - 1]!.seq;

    if (fromSeq > last) {
      // Caller is up to date or ahead — nothing to replay.
      return new Uint8Array(0);
    }
    if (fromSeq < first) {
      // Evicted.
      return null;
    }
    if (toSeq < fromSeq) {
      return new Uint8Array(0);
    }
    const effectiveTo = toSeq > last ? last : toSeq;

    // Collect entries in [fromSeq, effectiveTo]. Index is monotonically
    // increasing in seq (we only append at tail), so we can binary-search,
    // but linear scan is fine for typical sizes.
    let total = 0;
    const picked: FrameIndex[] = [];
    for (const e of this.index) {
      if (e.seq < fromSeq) continue;
      if (e.seq > effectiveTo) break;
      picked.push(e);
      total += e.byteLength;
    }

    const out = new Uint8Array(total);
    let cursor = 0;
    for (const e of picked) {
      if (e.byteLength === 0) continue;
      const end = e.byteOffset + e.byteLength;
      if (end <= this.capacity) {
        out.set(this.buf.subarray(e.byteOffset, end), cursor);
      } else {
        const tail = this.capacity - e.byteOffset;
        out.set(this.buf.subarray(e.byteOffset, this.capacity), cursor);
        out.set(this.buf.subarray(0, end - this.capacity), cursor + tail);
      }
      cursor += e.byteLength;
    }
    return out;
  }
}
