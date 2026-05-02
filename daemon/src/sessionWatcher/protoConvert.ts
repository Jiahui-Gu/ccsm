// Wire-side conversion between the watcher-internal `WatcherState`
// vocabulary (a string union mirroring the SDK) and the proto enum
// `ccsm.v1.SessionState` (carried as its numeric value, NOT imported
// directly to keep daemon's tsconfig rootDir contained to `src/`).
//
// Task #106. Pure deciders, no I/O. The daemon stores `WatcherState` in
// its in-memory snapshot table; the Connect handler converts at the
// wire boundary on emit.
//
// Numeric constants mirror `ccsm.v1.SessionState` in
// `proto/ccsm/v1/common.proto`:
//   SESSION_STATE_UNSPECIFIED      = 0
//   SESSION_STATE_IDLE             = 1
//   SESSION_STATE_RUNNING          = 2
//   SESSION_STATE_REQUIRES_ACTION  = 3
//   SESSION_STATE_EXITED           = 4
//
// Keeping the constants here (rather than importing from `gen/ts/...`)
// avoids touching daemon's tsconfig rootDir, which would cascade into
// the dist layout + bundler entry path. The Connect-route shim that
// hands these numbers to the proto schema lives at the wiring boundary
// (see `connectHandler.ts`).

import type { WatcherState } from './inference.js';

export const PROTO_SESSION_STATE = {
  UNSPECIFIED: 0,
  IDLE: 1,
  RUNNING: 2,
  REQUIRES_ACTION: 3,
  EXITED: 4,
} as const;

export type ProtoSessionStateNumeric =
  (typeof PROTO_SESSION_STATE)[keyof typeof PROTO_SESSION_STATE];

/**
 * Convert a watcher-internal state to the proto enum number. `'exited'`
 * is NOT a `WatcherState` — it's a lifecycle-terminal state owned by
 * the PTY layer (#108) and emitted via `SessionExited` delta — so this
 * function never returns `EXITED`.
 */
export function toProtoSessionState(s: WatcherState): ProtoSessionStateNumeric {
  switch (s) {
    case 'idle':
      return PROTO_SESSION_STATE.IDLE;
    case 'running':
      return PROTO_SESSION_STATE.RUNNING;
    case 'requires_action':
      return PROTO_SESSION_STATE.REQUIRES_ACTION;
  }
}

/**
 * Inverse: proto enum number → watcher-internal. Returns null for
 * UNSPECIFIED / EXITED so callers can decide whether to treat them as
 * a missing snapshot or surface them as a separate concept.
 */
export function fromProtoSessionState(n: number): WatcherState | null {
  switch (n) {
    case PROTO_SESSION_STATE.IDLE:
      return 'idle';
    case PROTO_SESSION_STATE.RUNNING:
      return 'running';
    case PROTO_SESSION_STATE.REQUIRES_ACTION:
      return 'requires_action';
    default:
      return null;
  }
}
