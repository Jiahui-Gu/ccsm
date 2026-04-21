// NDJSON line splitter for claude.exe stdout.
//
// Why this exists: claude.exe emits NDJSON (one JSON per line, '\n'-terminated)
// but stdout chunk boundaries are arbitrary. We must:
//   1. Use UTF-8 string decoding (setEncoding('utf8')) so multi-byte chars are
//      not split mid-byte across chunks. Node's StringDecoder (used internally
//      by setEncoding) holds incomplete code points until the next chunk.
//   2. Buffer half-lines across chunks (concat string buffer, indexOf '\n').
//   3. Tolerate giant single lines (assistant frames can be hundreds of KB).
//      We do NOT impose a hard cap by default — allocate as needed. An
//      optional safety cap can be configured (default 64 MiB) and emits an
//      error event when exceeded, then resets the buffer to avoid OOM.
//   4. Skip empty lines.
//   5. Flush remaining non-empty buffer on stream 'end'.
//
// We deliberately do NOT use the `readline` module — its backpressure
// behavior on long lines is documented as poor and it has a default line
// length cap that surprises callers (see Node issue #2540 and friends).

import { EventEmitter } from 'node:events';

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
   * buffer is a JS string). When exceeded, emit an ErrorEvent and reset the
   * internal buffer. Default: 64 * 1024 * 1024 (64 MiB) — well above the
   * largest assistant frame seen in practice.
   */
  maxLineLength?: number;
}

const DEFAULT_MAX_LINE_LENGTH = 64 * 1024 * 1024;

/**
 * Internal buffering core. Reused by both the async-iterable and EventEmitter
 * APIs so the parsing logic lives in exactly one place.
 */
class SplitterCore {
  private buf = '';
  private readonly maxLineLength: number;

  constructor(opts?: SplitterOptions) {
    this.maxLineLength = opts?.maxLineLength ?? DEFAULT_MAX_LINE_LENGTH;
  }

  /**
   * Push a chunk and yield zero or more events (lines + possibly an error if
   * the buffer overflows).
   */
  push(chunk: string): Array<LineEvent | ErrorEvent> {
    const events: Array<LineEvent | ErrorEvent> = [];
    this.buf += chunk;

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
      // Reset to avoid unbounded memory growth on a runaway producer.
      this.buf = '';
    }

    return events;
  }

  /**
   * Flush any trailing non-empty buffer as a final line. Called on stream end.
   */
  flush(): LineEvent | null {
    let line = this.buf;
    this.buf = '';
    if (line.endsWith('\r')) line = line.slice(0, -1);
    if (line.length === 0) return null;
    return { type: 'line', raw: line };
  }
}

function truncateContext(s: string): string {
  if (s.length <= 200) return s;
  return s.slice(0, 200);
}

// ---------------------------------------------------------------------------
// Async-iterable API
// ---------------------------------------------------------------------------

/**
 * Consume a Readable stream of NDJSON and yield LineEvent / ErrorEvent.
 *
 * Behavior:
 *  - Sets stream encoding to 'utf8' so chunks arrive as strings with
 *    multi-byte boundaries handled by Node's StringDecoder.
 *  - Yields each complete line (without the trailing '\n').
 *  - Yields an ErrorEvent if the per-line cap is exceeded; the buffer is
 *    then reset and parsing continues with subsequent chunks.
 *  - Yields a final LineEvent on 'end' if a non-empty trailing buffer
 *    remains (i.e. last line had no newline).
 *  - If the stream emits 'error', the iterator throws that error.
 */
export async function* splitNDJSON(
  stdout: NodeJS.ReadableStream,
  opts?: SplitterOptions,
): AsyncIterable<LineEvent | ErrorEvent> {
  // Force string mode. Calling this on an already-utf8 stream is a no-op.
  if (typeof (stdout as { setEncoding?: unknown }).setEncoding === 'function') {
    (stdout as NodeJS.ReadableStream & { setEncoding(enc: string): unknown })
      .setEncoding('utf8');
  }

  const core = new SplitterCore(opts);
  const queue: Array<LineEvent | ErrorEvent> = [];
  let ended = false;
  let streamError: Error | null = null;
  let wake: (() => void) | null = null;

  const onData = (chunk: unknown) => {
    // After setEncoding('utf8') chunk should be a string. Defensive coerce
    // in case the stream wasn't string-mode (e.g. caller passed a raw stream
    // and setEncoding was a no-op).
    const s = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8') // Note: this can split multi-byte chars at
                                  // chunk boundaries. The setEncoding path
                                  // above is the correct one; this is a
                                  // last-resort fallback.
        : String(chunk);
    for (const ev of core.push(s)) queue.push(ev);
    wake?.();
  };
  const onEnd = () => {
    const tail = core.flush();
    if (tail) queue.push(tail);
    ended = true;
    wake?.();
  };
  const onError = (err: Error) => {
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
        yield queue.shift()!;
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
  }
}

// ---------------------------------------------------------------------------
// EventEmitter API
// ---------------------------------------------------------------------------

export interface NDJSONSplitterEvents {
  line: (raw: string) => void;
  error: (err: Error, context: string) => void;
  end: () => void;
}

/**
 * EventEmitter wrapper over the same parsing core. Useful when the consumer
 * wants synchronous push semantics or needs `pause`/`resume` style backpressure
 * on the underlying stream (which is preserved automatically — we do not
 * read in flowing mode beyond what the source provides).
 *
 * Events:
 *  - 'line'  (raw: string)            — one complete line, no trailing '\n'
 *  - 'error' (err: Error, context)    — per-line cap exceeded OR stream error
 *  - 'end'   ()                        — source stream ended (after final flush)
 */
export class NDJSONSplitter extends EventEmitter {
  private readonly core: SplitterCore;
  private readonly stream: NodeJS.ReadableStream;
  private detached = false;

  private readonly onData = (chunk: unknown): void => {
    const s = typeof chunk === 'string'
      ? chunk
      : Buffer.isBuffer(chunk)
        ? chunk.toString('utf8')
        : String(chunk);
    for (const ev of this.core.push(s)) {
      if (ev.type === 'line') {
        this.emit('line', ev.raw);
      } else {
        this.emit('error', ev.error, ev.context);
      }
    }
  };
  private readonly onEnd = (): void => {
    const tail = this.core.flush();
    if (tail) this.emit('line', tail.raw);
    this.emit('end');
  };
  private readonly onError = (err: Error): void => {
    // Surface upstream errors with empty context — the buffer state at this
    // point is implementation-detail and not useful for diagnosing a network
    // / pipe failure.
    this.emit('error', err, '');
  };

  constructor(stream: NodeJS.ReadableStream, opts?: SplitterOptions) {
    super();
    this.core = new SplitterCore(opts);
    this.stream = stream;
    if (typeof (stream as { setEncoding?: unknown }).setEncoding === 'function') {
      (stream as NodeJS.ReadableStream & { setEncoding(enc: string): unknown })
        .setEncoding('utf8');
    }
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
