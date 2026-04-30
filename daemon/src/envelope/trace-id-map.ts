// streamId → traceId resolver for envelope log correlation (spec §3.4.1.c).
//
// Background. Per spec §3.4.1.c, the envelope header carries an optional
// `traceId` (Crockford ULID, 26 chars) on call-originating frames. Stream
// sub-frames intentionally OMIT `traceId` to keep per-chunk overhead minimal:
//
//   "Validate `traceId` against Crockford ULID regex **only when present**
//    (chunk/heartbeat sub-frames carry no traceId by design — resolved from
//    streamId map)."
//        — frag-3.4.1-envelope-hardening.md §3.4.1.d step 4 add
//
//   "traceId carve-out: `stream.kind === "chunk"` / `"heartbeat"` frames with
//    no `traceId` ACCEPTED; chunk for unknown `streamId` rejected with
//    `RESOURCE_EXHAUSTED`."
//        — same fragment, validation cases bullet
//
// This module owns ONE thing: a map of live streamId → traceId entries plus
// a predicate for which sub-frame kinds participate in the carve-out. It does
// not parse envelopes, does not log, does not validate ULIDs — that work lives
// in the adapter (T5 envelope.ts handles bytes; T9 schema validator handles
// ULID regex). Single Responsibility: pure data structure + predicate.

/**
 * Sub-frame kinds whose traceId attribution is governed by the carve-out rule.
 *
 * - `chunk`     — payload sub-frames split from a >16 KiB stream emit; inherit
 *                 traceId from the originating `open` frame via the streamId
 *                 map. Validator MUST accept frames with no `traceId`.
 * - `heartbeat` — keepalive sub-frames on a live stream; same inherit rule.
 * - `data`      — full request / reply envelopes (unary or stream `open` /
 *                 `close`). Carry their own `traceId` (caller-supplied or
 *                 minted by the trace interceptor); MAY rotate per call.
 *
 * Kept narrow on purpose — extending requires a spec amendment, not a code
 * change.
 */
export type FrameKindForCarveOut = 'chunk' | 'heartbeat' | 'data';

/**
 * Live streamId → traceId entries.
 *
 * Lifecycle expected by the adapter:
 *   1. Stream `open` frame arrives carrying its own `traceId`. Adapter calls
 *      `register(streamId, traceId)`.
 *   2. Subsequent `chunk` / `heartbeat` sub-frames omit `traceId` on the wire;
 *      adapter calls `resolve(streamId)` to attach the inherited value to log
 *      records / interceptor context.
 *   3. Stream `close` frame (or socket teardown) → adapter calls
 *      `release(streamId)` to drop the entry. Forgetting this leaks one entry
 *      per stream — manager owns the wiring; this module owns only the table.
 *
 * Concurrency: single-threaded by Node's event loop; no locking needed. Entries
 * are independent per streamId — re-`register` on a live id overwrites silently
 * (caller is responsible for ordering register before resolve).
 */
export class TraceIdMap {
  private readonly entries = new Map<string, string>();

  /**
   * Open or replace the trace span for `streamId`. Called on `stream.open` and
   * (defensively) on any data frame that carries a fresh `traceId` for an
   * already-live stream.
   */
  register(streamId: string, traceId: string): void {
    this.entries.set(streamId, traceId);
  }

  /**
   * Look up the inherited `traceId` for a chunk/heartbeat sub-frame. Returns
   * `undefined` for unknown ids — the adapter MUST translate that into a
   * `RESOURCE_EXHAUSTED` close per spec §3.4.1.d.
   */
  resolve(streamId: string): string | undefined {
    return this.entries.get(streamId);
  }

  /**
   * Drop the entry on `stream.close` or socket teardown. Idempotent — calling
   * on an unknown id is a no-op so teardown paths can call unconditionally.
   */
  release(streamId: string): void {
    this.entries.delete(streamId);
  }

  /**
   * Test / instrumentation hook. Not intended for production routing decisions.
   */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Carve-out predicate: does this sub-frame kind SKIP fresh-traceId attribution
 * and instead inherit from the streamId map?
 *
 * - `chunk`, `heartbeat` → `true` (carved out; resolve via map)
 * - `data`               → `false` (carries its own traceId; may rotate)
 *
 * Pure function, no map dependency — kept here so the predicate and the table
 * stay in one file and one spec citation.
 */
export function isCarveOutFrameType(type: FrameKindForCarveOut): boolean {
  return type === 'chunk' || type === 'heartbeat';
}
