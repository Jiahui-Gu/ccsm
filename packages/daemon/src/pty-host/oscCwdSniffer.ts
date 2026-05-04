// OSC 7 ("current working directory") sniffer for the pty-host child.
// Spec: ch07 §3 cwd_state (T5.8 / Task #66).
//
// Wire format (xterm / iTerm2 / VTE convention):
//   ESC ] 7 ; file://<host>/<path> BEL        (\x1b]7;file://<host>/<path>\x07)
//   ESC ] 7 ; file://<host>/<path> ST         (\x1b]7;file://<host>/<path>\x1b\\)
//
// The shell (claude's spawned shell, via PROMPT_COMMAND / precmd hooks) is
// responsible for emitting OSC 7 on every cd. The pty-host child is the SOLE
// observer for cwd updates — the daemon does NOT shell out to lsof / proc.
// On parse, this module emits {sid, cwd, ts}; the pty-host child posts a
// {kind:'cwd_update'} IPC message to the daemon main process which UPSERTs
// the cwd_state row through the write coalescer (ch07 §5). That wiring lands
// once T4.9 (delta accumulator) is merged and is intentionally out of scope
// here — this file is a pure producer (SRP) so each layer can be tested in
// isolation, mirroring the OSC 0/2 title sniffer in `ptyHost/oscTitleSniffer.ts`.
//
// Layer 1 / 5-tier note: in-repo `ptyHost/oscTitleSniffer.ts` already
// implements the same scan/buffer/per-sid/terminator pattern for OSC 0/2.
// Cloning that pattern (rather than introducing a different OSC parser
// flavor) keeps the codebase consistent — OSC framing across the two
// sniffers diverges only in the OSC code (`0`/`2` vs `7`) and the body
// interpretation (raw title vs file://-URI → cwd path).

import { EventEmitter } from 'events';

export interface OscCwdEvent {
  sid: string;
  /** Decoded absolute path (percent-decoding applied; file:// + host stripped). */
  cwd: string;
  ts: number;
}

// Cap per-sid buffer growth to defend against pathological streams that
// emit `\x1b]7;` and never terminate it (or just enormous non-OSC text).
// 64 KiB is enough to span any realistic split escape across chunks and
// matches the OSC 0/2 sniffer cap.
const MAX_BUFFER_BYTES = 64 * 1024;

const OSC7_PREFIX = '\x1b]7;';
const OSC7_PREFIX_LEN = OSC7_PREFIX.length; // 4 bytes

const FILE_SCHEME = 'file://';

/**
 * Decode the body of an OSC 7 sequence (the bytes between `\x1b]7;` and the
 * BEL/ST terminator) into an absolute filesystem path. Returns `null` if
 * the body does not parse as a `file://` URI we recognize.
 *
 * Spec contract:
 *   body = `file://<host>/<percent-encoded-path>`
 *   - <host> may be empty (e.g. `file:///tmp/foo`) or a hostname (often
 *     the literal machine hostname). We do NOT validate it — different
 *     shells emit different things and we only care about the path.
 *   - The path is percent-encoded per RFC 3986. We use `decodeURIComponent`
 *     to undo it; malformed sequences (e.g. `%ZZ`) yield `null` so the
 *     caller can drop the event rather than store garbage in cwd_state.
 *   - On Windows, paths arrive as `/C:/Users/foo` — we strip the leading
 *     slash so the result is a real Windows path (`C:/Users/foo`).
 *
 * Anything that doesn't start with `file://` is rejected (some shells
 * emit raw paths in OSC 7 — non-standard, ignored to avoid accepting
 * garbage as cwd).
 */
export function parseOsc7Body(body: string): string | null {
  if (!body.startsWith(FILE_SCHEME)) return null;
  // Strip `file://`, then strip everything up to the next `/` (the host).
  // If there is no `/` after the scheme we have a malformed URI.
  const afterScheme = body.slice(FILE_SCHEME.length);
  const slashIdx = afterScheme.indexOf('/');
  if (slashIdx === -1) return null;
  let path = afterScheme.slice(slashIdx); // keeps the leading `/`
  // Percent-decode. Malformed sequences throw — treat as parse failure.
  try {
    path = decodeURIComponent(path);
  } catch {
    return null;
  }
  // Windows: strip the leading `/` from `/X:/...` so we hand back a real
  // Windows path. POSIX paths (`/tmp/foo`) keep their leading slash.
  if (
    path.length >= 4 &&
    path.charCodeAt(0) === 0x2f /* '/' */ &&
    isAsciiLetter(path.charCodeAt(1)) &&
    path.charCodeAt(2) === 0x3a /* ':' */ &&
    path.charCodeAt(3) === 0x2f /* '/' */
  ) {
    path = path.slice(1);
  }
  if (path.length === 0) return null;
  return path;
}

function isAsciiLetter(code: number): boolean {
  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

export class OscCwdSniffer extends EventEmitter {
  private readonly buffers = new Map<string, string>();

  feed(sid: string, chunk: string | Buffer): void {
    if (chunk == null) return;
    const text = typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    if (text.length === 0) return;

    let buf = (this.buffers.get(sid) ?? '') + text;

    // Scan for complete OSC 7 sequences. Loop because one chunk can hold
    // multiple sequences (rare in practice for OSC 7, but cheap to handle).
    let scanFrom = 0;
    let lastEmitEnd = 0;
    while (scanFrom < buf.length) {
      const oscStart = buf.indexOf(OSC7_PREFIX, scanFrom);
      if (oscStart === -1) break;

      const bodyStart = oscStart + OSC7_PREFIX_LEN;

      // Find terminator: BEL (\x07) or ST (\x1b\\). Pick the earlier one.
      const belIdx = buf.indexOf('\x07', bodyStart);
      const stIdx = buf.indexOf('\x1b\\', bodyStart);

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

      const body = buf.slice(bodyStart, termIdx);
      const cwd = parseOsc7Body(body);
      if (cwd !== null) {
        this.emit('osc-cwd', {
          sid,
          cwd,
          ts: Date.now(),
        } satisfies OscCwdEvent);
      }
      // Malformed body: silently drop. Spec ch07 §3 is "OSC 7 is the SOLE
      // source of truth"; a junk body is just a no-op (cwd_state stays at
      // its last known good value or sessions.cwd fallback).

      scanFrom = termIdx + termLen;
      lastEmitEnd = scanFrom;
    }

    // Keep only the tail starting at the first byte we haven't consumed.
    // If we found an incomplete OSC 7 start, keep from there so the next
    // feed can complete it. Otherwise discard plain text but retain a
    // small (3-byte) tail so a split `\x1b]7` prefix straddling the chunk
    // boundary still completes next round. Mirrors the OSC 0/2 sniffer.
    let tail: string;
    const incompleteOscStart = buf.indexOf(OSC7_PREFIX, lastEmitEnd);
    if (incompleteOscStart !== -1) {
      tail = buf.slice(incompleteOscStart);
    } else {
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
