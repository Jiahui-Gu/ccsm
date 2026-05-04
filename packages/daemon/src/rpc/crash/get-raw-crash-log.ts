// packages/daemon/src/rpc/crash/get-raw-crash-log.ts
//
// Wave-3 Task #334 (sub-task 3 of audit #228) — production
// CrashService.GetRawCrashLog Connect server-streaming handler.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #3). Pre-#334 the entire `CrashService` was registered as
// an empty stub (#229 / PR #996 swapped in only `getCrashLog`); the
// router's "absent method -> Unimplemented" rule meant every client
// invocation of `GetRawCrashLog` returned `Code.Unimplemented` despite
// the on-disk `state/crash-raw.ndjson` file being the spec-pinned
// source for the renderer's "Download raw log" affordance (chapter 08
// §3 / 09 §2 — `file://` URLs are forbidden in `app:open-external`,
// so v0.4 web/iOS cannot stat a daemon-side path; the only forever-
// stable answer is to stream the bytes through the RPC).
//
// Spec refs:
//   - packages/proto/src/ccsm/v1/crash.proto:67-79 (forever-stable wire
//     shape: `GetRawCrashLogRequest{meta}`, `RawCrashChunk{data, eof}`,
//     "64 KiB max per chunk", "EOF is signaled by the stream completing
//     normally", "If the file does not exist (no fatal-via-NDJSON
//     crashes have occurred), daemon completes the stream after sending
//     zero chunks", "Errors map to INTERNAL with ErrorDetail.code =
//     'crash.raw_log_read_failed'").
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch09 §2 (`crash-raw.ndjson` is the daemon-self crash NDJSON
//     buffer; replay-on-boot truncates it; new fatal entries land via
//     the capture-source sink during runtime).
//   - docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
//     §sub-task 3 (this PR's brief — separate sub-task from #229
//     because server-streaming + 64 KiB chunk semantics are
//     non-overlapping with the unary GetCrashLog handler).
//
// SRP layering — three roles kept separate (dev.md §2):
//   * decider:  none required — the wire request carries only `meta`,
//               so there is no decision surface to factor out (the
//               equivalent of `decideGetCrashLogQuery` would be the
//               identity function). The chunk size cap and the
//               file-missing semantics are spec-pinned constants /
//               error-handling policy, not request-driven decisions.
//   * producer: `streamRawCrashChunks(opts)` — pure async generator
//               that opens a Node read stream against the supplied
//               path and yields `Uint8Array` chunks of at most
//               `RAW_CHUNK_MAX_BYTES`. The producer knows nothing
//               about Connect, the wire schema, or the principal —
//               it just turns "a file path" into "an async iterable
//               of byte chunks". Tested in isolation.
//   * sink:     `makeGetRawCrashLogHandler(deps)` — Connect handler
//               that wraps the producer's chunks into `RawCrashChunk`
//               protos, appends a terminal `eof=true` sentinel chunk,
//               and maps any read error to the spec-pinned
//               `crash.raw_log_read_failed` ErrorDetail.
//
// Layer 1 — alternatives checked:
//   - "Read the whole file into a buffer, then chunk it" — rejected.
//     The spec lists no upper bound on `crash-raw.ndjson` size; a fatal
//     loop (claudeExit storm) before boot-replay could reasonably leave
//     megabytes on disk. `fs.createReadStream` keeps memory pressure
//     bounded to one chunk, and Connect-ES backpressure means the
//     reader auto-pauses if the client drains slowly. Same posture as
//     `crash/raw-appender.ts` which uses `fs.appendFile` rather than
//     `fs.writeFile(JSON.stringify(allEntries))`.
//   - `node:stream/promises.pipeline` into a writable that pushes onto
//     a queue — rejected as more LOC than `for await (const c of
//     readStream) yield ...`. Connect-ES's server-streaming handler
//     contract is "return AsyncIterable" — Node's read streams already
//     ARE AsyncIterables (since Node 10), so the simplest possible
//     adapter is the right answer.
//   - Wrap in `it-pushable` / `rxjs` / similar — zero of these are
//     daemon deps; introducing one for a 30-line adapter is the
//     dep-creep anti-pattern dev.md §1 calls out.
//   - Snapshot the file (open + stat the inode, then read) so the
//     stream is consistent against a concurrent write — rejected.
//     Spec ch09 §2 / crash.proto comment "Daemon reads the file at
//     request time (NOT a snapshot — caller sees the file as of read)"
//     pins the wire contract: torn read is acceptable; snapshot is not
//     a v0.3 requirement. The capture-source sink (`raw-appender.ts`)
//     uses POSIX append semantics so a torn read can only ever land
//     between newline-terminated entries — the renderer concatenates
//     bytes and treats the result as line-delimited JSON, which
//     tolerates a partial trailing line at the boundary.
//   - Filter out lines for non-caller principals (mirror of
//     GetCrashLog's owner filter) — rejected by spec. crash.proto
//     comment is explicit: "owner-scoped filtering does NOT apply —
//     the raw log is daemon-self by definition; peer-cred middleware
//     still scopes admin-only for v0.4." For v0.3 the wire is open to
//     any authenticated principal (the only principal kind today).
//   - Add a `crash.raw_log_read_failed` row to STANDARD_ERROR_MAP in
//     `rpc/errors.ts` — DONE in the same PR. The spec hard-pins both
//     the string code and the Connect code (Internal); the closed-enum
//     `STANDARD_ERROR_MAP` is the daemon-side single source of truth
//     for that mapping (per `errors.ts` header comment), so the right
//     home for this code is the table, not a hand-rolled ConnectError.

import { createReadStream } from 'node:fs';

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  type CrashService,
  RawCrashChunkSchema,
  type RawCrashChunk,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal } from '../../auth/index.js';
import { buildError } from '../errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Forever-stable wire cap on `RawCrashChunk.data` size: 64 KiB
 * (`packages/proto/src/ccsm/v1/crash.proto:77-78` — "daemon emits 64
 * KiB max per chunk"). Also the `highWaterMark` we hand to
 * `fs.createReadStream` so each pull from the read stream produces a
 * single proto-bound chunk without the producer having to re-chunk.
 *
 * Exported for unit tests (the producer's "split a 200 KiB file into
 * 4 chunks" assertion is keyed off this value, not a hard-coded `65536`,
 * so a future spec amendment to the wire cap auto-propagates).
 */
export const RAW_CHUNK_MAX_BYTES = 64 * 1024;

// ---------------------------------------------------------------------------
// Producer — file → AsyncIterable<Uint8Array>
// ---------------------------------------------------------------------------

export interface StreamRawCrashChunksOptions {
  /** Absolute path to `state/crash-raw.ndjson` (the daemon's state-dir
   *  resolves this via `statePaths().crashRaw`; the handler is
   *  injected with that resolved path so this producer never touches
   *  the per-OS resolver). */
  readonly path: string;
  /**
   * AbortSignal used to tear the underlying read stream down when the
   * client disconnects or the server is shutting down. Connect-ES
   * passes `HandlerContext.signal` through to the handler — the
   * handler forwards it here.
   */
  readonly signal?: AbortSignal;
  /** Override the chunk size — tests use a small value to exercise
   *  multi-chunk behavior without staging a 64 KiB+ fixture file. */
  readonly chunkSize?: number;
}

/**
 * Async-iterable adapter over `fs.createReadStream`. Each yielded
 * `Uint8Array` is at most `chunkSize` (default `RAW_CHUNK_MAX_BYTES`)
 * bytes; the producer does NOT yield a terminal sentinel — the sink
 * is responsible for emitting the `eof=true` `RawCrashChunk` after
 * the iterable completes. This separation keeps the producer wire-
 * agnostic (it knows about bytes, not about proto messages).
 *
 * File-missing semantics (spec ch09 §2 / crash.proto comment):
 *   - ENOENT → the iterable completes after yielding zero chunks.
 *     This is the first-boot shape (no fatal-via-NDJSON crashes
 *     have occurred yet) and is NOT an error.
 *   - Any other read error → re-thrown so the sink can map it to
 *     the spec-pinned `crash.raw_log_read_failed` ConnectError.
 *
 * Backpressure: Connect-ES drains the AsyncIterable at the wire's
 * pace; `for await` over a Node read stream automatically pauses /
 * resumes the stream so memory stays bounded to one chunk regardless
 * of file size or client speed.
 */
export async function* streamRawCrashChunks(
  opts: StreamRawCrashChunksOptions,
): AsyncGenerator<Uint8Array, void, undefined> {
  const chunkSize = opts.chunkSize ?? RAW_CHUNK_MAX_BYTES;
  // Construct the read stream lazily inside the generator. Note that
  // `createReadStream` does NOT throw synchronously for ENOENT — the
  // error surfaces as an `error` event on the stream and is caught by
  // the `for await` consumer below. Synchronous throws here are limited
  // to invalid arguments (e.g. an empty path string), which propagate
  // unwrapped to the sink and become a `crash.raw_log_read_failed`
  // ConnectError just like any other read failure.
  const stream = createReadStream(opts.path, {
    highWaterMark: chunkSize,
    signal: opts.signal,
  });
  try {
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      // Node's `Buffer` extends `Uint8Array`; the cast is free at runtime.
      yield chunk;
    }
  } catch (err) {
    // ENOENT is the spec-pinned "no fatal crashes yet" shape — swallow
    // and let the iterable complete with zero chunks yielded.
    if (
      err !== null &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: unknown }).code === 'ENOENT'
    ) {
      return;
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Sink — Connect handler
// ---------------------------------------------------------------------------

export interface GetRawCrashLogDeps {
  /** Absolute path to the daemon's `state/crash-raw.ndjson`. Wired
   *  by `runStartup` to `statePaths().crashRaw` (the same path the
   *  capture-source sink writes to and `replayCrashRawOnBoot` reads
   *  from). */
  readonly crashRawPath: string;
}

/**
 * Build the Connect `ServiceImpl<typeof CrashService>['getRawCrashLog']`
 * server-streaming handler. Reads `PRINCIPAL_KEY` from the
 * HandlerContext (the `peerCredAuthInterceptor` deposited it before
 * the handler runs — a missing principal is a daemon wiring bug
 * surfaced as `Internal` rather than `Unauthenticated`, mirroring
 * `get-crash-log.ts` and `sessions/watch-sessions.ts`), then drains
 * the producer and yields proto chunks.
 *
 * Terminal-chunk policy: every successful stream ends with a single
 * `RawCrashChunk{data: empty, eof: true}` sentinel. This keeps the
 * wire shape uniform across all three cases (file missing, file
 * empty, file non-empty) — the renderer always sees the same EOF
 * marker rather than having to distinguish "stream ended" from
 * "stream ended with a non-empty last chunk". crash.proto comment
 * "may also be true on a zero-byte chunk if file is empty" pins
 * that this is wire-legal.
 *
 * Error-mapping policy: ANY read error other than ENOENT (which the
 * producer swallows) is mapped to a `ConnectError` with `Code.Internal`
 * and a structured `ErrorDetail.code = 'crash.raw_log_read_failed'`
 * (per crash.proto comment + ch09 §2). The original error's message
 * is preserved as the human-readable `ConnectError` message so
 * operators reading daemon logs see the underlying I/O failure.
 */
export function makeGetRawCrashLogHandler(
  deps: GetRawCrashLogDeps,
): ServiceImpl<typeof CrashService>['getRawCrashLog'] {
  return async function* getRawCrashLog(
    _req,
    handlerContext: HandlerContext,
  ): AsyncGenerator<RawCrashChunk, void, undefined> {
    const principal: Principal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'GetRawCrashLog handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }
    try {
      for await (const bytes of streamRawCrashChunks({
        path: deps.crashRawPath,
        signal: handlerContext.signal,
      })) {
        yield create(RawCrashChunkSchema, {
          data: bytes,
          eof: false,
        });
      }
    } catch (err) {
      // Map any non-ENOENT read error to the spec-pinned
      // `crash.raw_log_read_failed` structured error. Carry the
      // underlying message in the human-readable slot for operator
      // diagnostics; the wire contract is the (Code.Internal,
      // ErrorDetail.code) pair.
      const underlying = err instanceof Error ? err.message : String(err);
      throw buildError(
        'crash.raw_log_read_failed',
        `Failed to read ${deps.crashRawPath}: ${underlying}`,
      );
    }
    // Terminal EOF sentinel — see header comment "Terminal-chunk policy".
    yield create(RawCrashChunkSchema, {
      data: new Uint8Array(0),
      eof: true,
    });
  };
}
