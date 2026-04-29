// Phase B of the notify pipeline (Task #688): a pure producer that scans
// PTY stdout byte streams for OSC title escape sequences and emits the
// raw title string. It does NOT interpret titles ('waiting'/'running'/etc.)
// — that is the decider's job (Task #687). It does NOT wire into ptyHost or
// IPC — that is the sink's job (Task #689). This file is a standalone
// EventEmitter so each layer can be tested in isolation.
//
// OSC 0 / OSC 2 spec (Task #713 — merged dual-mode producer):
//   ESC ] 0 ; <title> BEL              (\x1b]0;<title>\x07)
//   ESC ] 0 ; <title> ST               (\x1b]0;<title>\x1b\\)
//   ESC ] 2 ; <title> BEL              (\x1b]2;<title>\x07)
//   ESC ] 2 ; <title> ST               (\x1b]2;<title>\x1b\\)
// Either terminator is valid; xterm/Windows Terminal/Claude CLI all use BEL
// in practice, but we accept ST for robustness. Some Claude CLI builds emit
// OSC 2 (window title) instead of OSC 0 (icon+window title) — both are
// title-class events for our purposes.
//
// Per-sid buffering is required because a chunk boundary can split an
// escape sequence in half. We append, scan for complete sequences, emit,
// then keep the incomplete tail (if any) for the next feed call.

import { EventEmitter } from 'events';

export interface OscTitleEvent {
  sid: string;
  title: string;
  ts: number;
}

// Cap per-sid buffer growth to defend against pathological streams that
// emit `\x1b]0;` and never terminate it (or just enormous non-OSC text).
// 64 KiB is enough to span any realistic split escape across chunks.
const MAX_BUFFER_BYTES = 64 * 1024;

const OSC_PREFIXES = ['\x1b]0;', '\x1b]2;'] as const;
const OSC_PREFIX_LEN = 4; // both prefixes are 4 bytes

// Find the earliest index in `buf` (>= from) where any recognized OSC
// title prefix starts. Returns -1 if none.
function findNextOscStart(buf: string, from: number): number {
  let earliest = -1;
  for (const p of OSC_PREFIXES) {
    const idx = buf.indexOf(p, from);
    if (idx !== -1 && (earliest === -1 || idx < earliest)) {
      earliest = idx;
    }
  }
  return earliest;
}

export class OscTitleSniffer extends EventEmitter {
  private readonly buffers = new Map<string, string>();

  feed(sid: string, chunk: string | Buffer): void {
    if (chunk == null) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) return;

    let buf = (this.buffers.get(sid) ?? '') + text;

    // Scan for complete OSC 0/2 sequences. Loop because one chunk can hold
    // multiple sequences.
    let scanFrom = 0;
    let lastEmitEnd = 0;
    while (scanFrom < buf.length) {
      const oscStart = findNextOscStart(buf, scanFrom);
      if (oscStart === -1) break;

      const titleStart = oscStart + OSC_PREFIX_LEN;

      // Find terminator: BEL (\x07) or ST (\x1b\\). Pick the earlier one.
      const belIdx = buf.indexOf('\x07', titleStart);
      const stIdx = buf.indexOf('\x1b\\', titleStart);

      let termIdx = -1;
      let termLen = 0;
      if (belIdx !== -1 && (stIdx === -1 || belIdx < stIdx)) {
        termIdx = belIdx;
        termLen = 1;
      } else if (stIdx !== -1) {
        termIdx = stIdx;
        termLen = 2;
      }

      if (termIdx === -1) {
        // Incomplete escape — leave it (and everything before it that we
        // haven't yet consumed) for the next feed.
        break;
      }

      const title = buf.slice(titleStart, termIdx);
      this.emit('osc-title', {
        sid,
        title,
        ts: Date.now(),
      } satisfies OscTitleEvent);

      scanFrom = termIdx + termLen;
      lastEmitEnd = scanFrom;
    }

    // Keep only the tail starting at the first byte we haven't consumed.
    // If we found an incomplete OSC start, we want to keep from that point
    // so the next feed can complete it. If no OSC at all, keep nothing
    // (it's all plain text we don't care about) — but cap by
    // MAX_BUFFER_BYTES in case the tail is huge.
    let tail: string;
    const incompleteOscStart = findNextOscStart(buf, lastEmitEnd);
    if (incompleteOscStart !== -1) {
      tail = buf.slice(incompleteOscStart);
    } else {
      // No partial OSC pending. Discard plain text so the buffer doesn't
      // grow unbounded. Keep last 3 bytes only so a split `\x1b]0` /
      // `\x1b]2` prefix straddling the chunk boundary still completes
      // next round.
      tail = buf.slice(Math.max(buf.length - 3, lastEmitEnd));
    }

    if (tail.length > MAX_BUFFER_BYTES) {
      // Truncate from the LEFT — keep the most recent bytes since an OSC
      // terminator (if it ever arrives) will appear later in the stream.
      tail = tail.slice(tail.length - MAX_BUFFER_BYTES);
    }

    if (tail.length === 0) {
      this.buffers.delete(sid);
    } else {
      this.buffers.set(sid, tail);
    }
  }

  clear(sid: string): void {
    this.buffers.delete(sid);
  }
}
