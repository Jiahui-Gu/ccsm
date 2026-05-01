// Marker file reader (T22, v0.3 spec §6.4 + §3 — "Marker corruption /
// partial write (rel-S-R8): if the marker file exists but is unreadable
// / malformed JSON, treat as PRESENT").
//
// Decision table (single source of truth):
//
//   File state                            -> result
//   -----------------------------------------------------------------
//   ENOENT (no file)                       -> { kind: 'absent' }
//   Empty file                             -> { kind: 'present' }     // partial-write window: O_CREAT done, content not yet rename()'d
//   Unparseable JSON                       -> { kind: 'present' }     // half-flushed bytes, treat as PRESENT
//   JSON missing required fields           -> { kind: 'present' }     // forward-compat: don't reject
//   Valid JSON with required fields        -> { kind: 'present', payload }
//   Any other I/O error (EACCES/EBUSY/...) -> { kind: 'present' }     // fail-safe: assume marker exists
//
// Rationale (spec §6.4 + §6.1 R2): we prefer a false-negative on the
// crash-loop counter (a "marker present" reading suppresses the
// counter increment for one boot) over a false-positive that would
// trip the rollback path on a legitimate post-upgrade boot. Treating
// any non-ENOENT condition as PRESENT is the conservative read.
//
// T13 runtimeRoot is not yet merged at the time of writing (parallel
// worker). The default marker path constant below is a placeholder
// derived directly from the spec wording ("`<dataRoot>/daemon.shutdown`
// marker file"). Once T13 lands, the wiring layer will pass an
// absolute path computed from `runtimeRoot`/`dataRoot` and this
// constant becomes irrelevant — the reader itself is path-agnostic.

import { promises as fs } from 'node:fs';

/** Default marker filename per spec §6.4. Joined under `dataRoot` by the wiring layer. */
export const DAEMON_SHUTDOWN_MARKER_FILENAME = 'daemon.shutdown';

/** Spec-defined payload shape (§6.4 line "Marker payload is a single line"). */
export interface ShutdownMarkerPayload {
  reason: 'upgrade' | string;
  version: string;
  ts: number;
}

export type MarkerReadResult =
  | { kind: 'absent' }
  | { kind: 'present'; payload?: ShutdownMarkerPayload; reason?: MarkerCorruptionReason };

/**
 * Why the reader downgraded to "present without payload". Useful for
 * the caller to emit the `marker_corrupt` warn log (spec §6.4).
 */
export type MarkerCorruptionReason =
  | 'empty'
  | 'invalid-json'
  | 'missing-fields'
  | 'io-error';

/**
 * Read the daemon-shutdown marker. See decision table above.
 *
 * IMPORTANT: This function never throws. Anything other than ENOENT is
 * a "present" result by spec.
 */
export async function readMarker(path: string): Promise<MarkerReadResult> {
  let raw: string;
  try {
    raw = await fs.readFile(path, 'utf8');
  } catch (err) {
    if (isEnoent(err)) {
      return { kind: 'absent' };
    }
    // EACCES, EBUSY, EISDIR, EMFILE, etc. — fail safe.
    return { kind: 'present', reason: 'io-error' };
  }

  // O_CREAT happened but content not yet written (or fully truncated).
  // Treat as a half-written marker == present.
  if (raw.length === 0) {
    return { kind: 'present', reason: 'empty' };
  }

  // Strip BOM / surrounding whitespace before JSON parse so a single
  // trailing newline doesn't accidentally count as "valid".
  const trimmed = raw.replace(/^\ufeff/, '').trim();
  if (trimmed.length === 0) {
    return { kind: 'present', reason: 'empty' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'present', reason: 'invalid-json' };
  }

  if (!isShutdownMarkerPayload(parsed)) {
    return { kind: 'present', reason: 'missing-fields' };
  }

  return { kind: 'present', payload: parsed };
}

function isEnoent(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === 'ENOENT'
  );
}

function isShutdownMarkerPayload(value: unknown): value is ShutdownMarkerPayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.reason === 'string' &&
    typeof v.version === 'string' &&
    typeof v.ts === 'number' &&
    Number.isFinite(v.ts)
  );
}
