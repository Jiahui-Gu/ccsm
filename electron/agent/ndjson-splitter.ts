// NDJSON line splitter for claude.exe stdout.
//
// Why this exists: claude.exe emits NDJSON (one JSON per line, '\n'-terminated)
// but stdout chunk boundaries are arbitrary. We must:
//   1. Decode UTF-8 ourselves (internal StringDecoder) so multi-byte chars are
//      not split mid-byte across chunks AND so we can detect incomplete byte
//      sequences at stream end (decoder.end() returns any held bytes).
//   2. Buffer half-lines across chunks (concat string buffer, indexOf '\n').
//   3. Tolerate giant single lines (assistant frames can be hundreds of KB),
//      with a configurable safety cap (default 8 MiB — see SplitterOptions).
//   4. Skip empty lines.
//   5. Flush remaining non-empty buffer on stream 'end' (and on 'error').
//   6. Backpressure: the async-iterable API pauses the source stream when its
//      internal queue exceeds a high-water mark, and resumes once drained
//      below half. This is critical because control_request handling is
//      async (e.g. wait for user UI approval) and a slow consumer would
//      otherwise let the queue grow unbounded.
//
// We deliberately do NOT use the `readline` module — its backpressure
// behavior on long lines is documented as poor and it has a default line
// length cap that surprises callers (see Node issue #2540 and friends).
// We also deliberately do NOT use split2 / ndjson npm packages — neither
// surfaces explicit per-line cap errors nor stream-end UTF-8 residue.

import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';

export interface LineEvent {
  type: 'line';
  raw: string;
}

export interface ErrorEvent {
  type: 'error';
  error: Error;
  context: string;
}

export interface SplitterOptions {
  /**
   * Hard cap for a single line, in characters (UTF-16 code units, since the
   * buffer is a JS string). When exceeded, emit an ErrorEvent, reset the
   * buffer, and discard subsequent input until the next newline (so the
   * "tail" of the dropped line cannot contaminate the start of the next).
   *
   * Default: 8 * 1024 * 1024 (8 MiB chars ≈ 16 MiB of V8 heap).
   *
   * Rationale: the largest claude.exe assistant frame observed in practice
   * is a few hundred KB; even a 128k-token context max-out is ~1-2 MiB.
   * 8 MiB gives ~8x headroom while staying friendly to low-RAM machines.
   * If you hit this cap, the upstream protocol probably changed.
   */
  maxLineLength?: number;

  /**
   * Async-iterable backpressure: pause the source stream when the internal
   * queue holds this many events. The stream is resumed once the queue
   * drains to highWaterMarkLines/2. Default: 256.
   *
   * Only affects splitNDJSON (async iterable). The EventEmitter API does
   * not buffer — listeners run synchronously inside 'data' handling.
   */
  highWaterMarkLines?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 8 * 1024 * 1024;
const DEFAULT_HWM_LINES = 256;

/**
 * Internal buffering core. Reused by both the async-iterable and EventEmitter
 * APIs so the parsing logic lives in exactly one place.
 *
 * Owns its own StringDecoder so callers do not need to (and should not)
 * call setEncoding on the source stream. push() takes raw Buffer or string.
 */
class SplitterCore {
  private buf = '';
  private readonly decoder = new StringDecoder('utf8');
  private readonly maxLineLength: number;
  /**
   * After an overflow we drop the in-flight line. The next chunk may arrive
   * mid-line (the tail of the dropped line). Skip everything up to the next
   * '\n' so we don't emit the tail as a fresh line.
   */
  private discardUntilNewline = false;

  constructor(opts?: SplitterOptions) {
    this.maxLineLength = opts?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Push a chunk and yield zero or more events. Accepts Buffer (preferred —
   * goes through StringDecoder, safe across multi-byte boundaries) or string
   * (assumed already decoded by the caller).
   */
  push(chunk: Buffer | string): Array<LineEvent | ErrorEvent> {
    const events: Array<LineEvent | ErrorEvent> = [];
    let s: string;
    if (typeof chunk === 'string') {
      s = chunk;
    } else {
      s = this.decoder.write(chunk);
    }

    if (this.discardUntilNewline) {
      const nl = s.indexOf('\n');
      if (nl < 0) return events; // still discarding
      s = s.slice(nl + 1);
      this.discardUntilNewline = false;
    }

    this.buf += s;

    let nl: number;
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      // Slice off one line. Preserve content as-is (no trim) — the caller is
      // free to JSON.parse, which tolerates leading/trailing whitespace.
      // We strip a trailing '\r' to be friendly to CRLF, but otherwise keep
      // bytes verbatim.
      let line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line.length === 0) continue; // skip empty lines (incl. \n\n)
      events.push({ type: 'line', raw: line });
    }

    // Overflow check after consuming all complete lines.
    if (this.buf.length > this.maxLineLength) {
      const ctx = truncateContext(this.buf);
      events.push({
        type: 'error',
        error: new Error(
          `NDJSON line exceeded maxLineLength=${this.maxLineLength} ` +
            `(buffered=${this.buf.length} chars without newline)`,
        ),
        context: ctx,
      });
      // Reset to avoid unbounded memory growth on a runaway producer, and
      // arm the discard flag so the (mid-line) tail of the dropped line in
      // a subsequent chunk does not become the start of a phantom new line.
      this.buf = '';
      this.discardUntilNewline = true;
    }

    return events;
  }

  /**
   * Flush any trailing non-empty buffer + decoder residue. Called on stream
   * end (or error). Returns events: at most one LineEvent and at most one
   * ErrorEvent (if the StringDecoder still held an incomplete UTF-8 byte
   * sequence — a real, observable failure mode when claude.exe is killed
   * mid-codepoint).
   */
  flush(): Array<LineEvent | ErrorEvent> {
    const events: Array<LineEvent | ErrorEvent> = [];
    // Drain any held bytes from the decoder. If non-empty, those bytes were
    // an incomplete UTF-8 sequence at stream end → surface as ErrorEvent.
    // (decoder.end() returns "" if it had no held bytes, otherwise it returns
    // U+FFFD replacement characters — we treat any non-empty residue as an
    // error and DO NOT include it in the flushed line.)
    const residue = this.decoder.end();
    if (residue.length > 0) {
      events.push({
        type: 'error',
        error: new Error(
          `Incomplete UTF-8 byte sequence at stream end ` +
            `(${residue.length} replacement char(s) discarded)`,
        ),
        context: '',
      });
    }
    if (this.discardUntilNewline) {
      // Mid-discard at end-of-stream: drop whatever is buffered, no tail line.
      this.buf = '';
      return events;
    }
    let line = this.buf;
    this.buf = '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length > 0) {
      events.push({ type: 'line', raw: line });
    }
    return events;
  }
}

function truncateContext(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Async-iterable API (recommended for production use)
// ---------------------------------------------------------------------------

/**
 * Consume a Readable stream of NDJSON and yield LineEvent / ErrorEvent.
 *
 * Behavior:
 *  - Decodes UTF-8 internally via StringDecoder (do NOT pre-call setEncoding
 *    on the stream — we need raw Buffer chunks to surface incomplete-sequence
 *    errors at stream end).
 *  - Yields each complete line (without the trailing '\n').
 *  - Yields an ErrorEvent if the per-line cap is exceeded; the buffer is
 *    then reset, the in-flight line tail (in the next chunk) is discarded
 *    up to the next '\n', and parsing continues.
 *  - Yields a final LineEvent on 'end' if a non-empty trailing buffer
 *    remains. Yields an ErrorEvent if the decoder held incomplete UTF-8.
 *  - On stream 'error': flushes residue + tail line FIRST, then throws the
 *    error (so consumers don't lose the last line buffered before the error).
 *  - Backpressure: pauses the source when the internal queue exceeds
 *    highWaterMarkLines (default 256), resumes when it drains to half.
 *    This makes async consumers safe — slow await per-line will not blow
 *    up memory.
 */
export async function* splitNDJSON(
  stdout: NodeJS.ReadableStream,
  opts?: SplitterOptions,
): AsyncIterable<LineEvent | ErrorEvent> {
  const core = new SplitterCore(opts);
  const hwm = Math.max(1, opts?.highWaterMarkLines ?? DEFAULT_HWM_LINES);
  const lwm = Math.max(1, Math.floor(hwm / 2));

  const queue: Array<LineEvent | ErrorEvent> = [];
  let ended = false;
  let streamError: Error | null = null;
  let wake: (() => void) | null = null;
  let paused = false;

  const canPause = typeof (stdout as { pause?: unknown }).pause === 'function'
    && typeof (stdout as { resume?: unknown }).resume === 'function';

  const maybePause = () => {
    if (canPause && !paused && queue.length >= hwm) {
      paused = true;
      (stdout as NodeJS.ReadableStream).pause();
    }
  };
  const maybeResume = () => {
    if (canPause && paused && queue.length <= lwm && !ended) {
      paused = false;
      (stdout as NodeJS.ReadableStream).resume();
    }
  };

  const onData = (chunk: unknown) => {
    // Prefer Buffer (decoder path is UTF-8-safe). Strings are accepted in
    // case the caller already set encoding for some reason.
    const evs = Buffer.isBuffer(chunk)
      ? core.push(chunk)
      : typeof chunk === 'string'
        ? core.push(chunk)
        : core.push(String(chunk));
    for (const ev of evs) queue.push(ev);
    maybePause();
    wake?.();
  };
  const onEnd = () => {
    for (const ev of core.flush()) queue.push(ev);
    ended = true;
    wake?.();
  };
  const onError = (err: Error) => {
    // Flush pending tail + decoder residue BEFORE surfacing the error so
    // the consumer doesn't silently lose the last buffered line.
    for (const ev of core.flush()) queue.push(ev);
    streamError = err;
    ended = true;
    wake?.();
  };

  stdout.on('data', onData);
  stdout.on('end', onEnd);
  stdout.on('error', onError);

  try {
    while (true) {
      while (queue.length > 0) {
        const ev = queue.shift()!;
        // Resume BEFORE yielding so the producer can refill while the
        // consumer is processing. The await on next iteration also gives
        // the event loop a chance to deliver more 'data' events.
        maybeResume();
        yield ev;
      }
      if (ended) {
        if (streamError) throw streamError;
        return;
      }
      await new Promise<void>((resolve) => {
        wake = () => {
          wake = null;
          resolve();
        };
      });
    }
  } finally {
    stdout.off('data', onData);
    stdout.off('end', onEnd);
    stdout.off('error', onError);
    // Make sure we don't leave the source paused if the consumer bailed early.
    if (canPause && paused) {
      try { (stdout as NodeJS.ReadableStream).resume(); } catch { /* ignore */ }
    }
  }
}

// ---------------------------------------------------------------------------
// EventEmitter API (kept for callers that want push semantics)
// ---------------------------------------------------------------------------

/**
 * EventEmitter wrapper over the same parsing core.
 *
 * Prefer `splitNDJSON` for new code: it integrates cleanly with `for await`,
 * supports backpressure automatically, and gives a single try/catch surface
 * for both stream errors and per-line cap errors.
 *
 * Events:
 *  - 'line'  (raw: string)            — one complete line, no trailing '\n'
 *  - 'error' (err: Error, context)    — per-line cap exceeded OR stream error
 *                                       OR incomplete UTF-8 at end
 *  - 'end'   ()                        — terminal event. Emitted exactly once
 *                                       on either source 'end' OR 'error'
 *                                       (after the error event), so listeners
 *                                       waiting on 'end' for cleanup do not
 *                                       hang on stream failure.
 *
 * The trailing line (if any) AND any decoder residue error are flushed
 * before 'end', regardless of whether the source ended normally or errored.
 *
 * @internal Prefer splitNDJSON unless you specifically need EE semantics.
 */
export interface NDJSONSplitterEvents {
  line: (raw: string) => void;
  error: (err: Error, context: string) => void;
  end: () => void;
}

export class NDJSONSplitter extends EventEmitter {
  private readonly core: SplitterCore;
  private readonly stream: NodeJS.ReadableStream;
  private detached = false;
  private terminated = false;

  private readonly onData = (chunk: unknown): void => {
    const evs = Buffer.isBuffer(chunk)
      ? this.core.push(chunk)
      : typeof chunk === 'string'
        ? this.core.push(chunk)
        : this.core.push(String(chunk));
    for (const ev of evs) {
      if (ev.type === 'line') {
        this.emit('line', ev.raw);
      } else {
        this.emit('error', ev.error, ev.context);
      }
    }
  };
  private readonly onEnd = (): void => {
    if (this.terminated) return;
    this.terminated = true;
    for (const ev of this.core.flush()) {
      if (ev.type === 'line') this.emit('line', ev.raw);
      else this.emit('error', ev.error, ev.context);
    }
    this.emit('end');
  };
  private readonly onError = (err: Error): void => {
    if (this.terminated) return;
    this.terminated = true;
    // Flush residue + tail line first.
    for (const ev of this.core.flush()) {
      if (ev.type === 'line') this.emit('line', ev.raw);
      else this.emit('error', ev.error, ev.context);
    }
    // Surface upstream error with empty context (buffer state is impl detail).
    this.emit('error', err, '');
    // Always emit 'end' so listeners waiting on it for cleanup don't hang.
    this.emit('end');
  };

  constructor(stream: NodeJS.ReadableStream, opts?: SplitterOptions) {
    super();
    this.core = new SplitterCore(opts);
    this.stream = stream;
    // Note: we do NOT call setEncoding. The core owns its own StringDecoder
    // so we receive raw Buffer chunks and can surface incomplete-sequence
    // errors at stream end.
    stream.on('data', this.onData);
    stream.on('end', this.onEnd);
    stream.on('error', this.onError);
  }

  /**
   * Detach all listeners from the source stream. Idempotent. Useful if the
   * caller wants to abandon parsing without ending the stream.
   */
  detach(): void {
    if (this.detached) return;
    this.detached = true;
    this.stream.off('data', this.onData);
    this.stream.off('end', this.onEnd);
    this.stream.off('error', this.onError);
  }
}
