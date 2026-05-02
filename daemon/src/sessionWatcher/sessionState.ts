// Per-session snapshot + delta state machine (daemon-side).
//
// Task #106 (v0.3 SessionWatcher 搬 daemon). Owns the
// authoritative in-memory snapshot for one session id and produces
// `SessionEventLike` deltas as the JSONL transcript evolves. Plural-
// `sessions` model from `proto/ccsm/v1/sessions.proto` —
// snapshot+delta+last-writer-wins per final-arch §2.7.
//
// SRP:
//   - DECIDER: ingest (state, title, cwd, pid) updates + decide whether
//     to emit a delta. Owns the per-session monotonic `seq`.
//   - Knows nothing about file watching (FileSource) or subscriber
//     fan-out (SessionSubscriberRegistry). The tick loop wires them
//     together in `index.ts`.
//
// POJO shapes mirror the proto JSON form (camelCase, the canonical
// wire form per r3-fwdcompat CF-2). The Connect-route shim
// (`connectHandler.ts`) consumes these and converts to the typed proto
// `SessionEvent` at the wire boundary.

import type { ProtoSessionStateNumeric } from './protoConvert.js';
import type { WatcherState } from './inference.js';
import { toProtoSessionState } from './protoConvert.js';

// ---------------------------------------------------------------------------
// POJO event shapes (mirror gen/ts/ccsm/v1/session_events_pb.ts)
// ---------------------------------------------------------------------------

export interface SessionSnapshotPojo {
  sessionId: string;
  seq: number;
  state: ProtoSessionStateNumeric;
  title: string;
  cwd: string;
  spawnCwd: string;
  spawnedAtMs: number;
  pid: number;
}

export interface SessionSnapshotEventPojo {
  kind: 'snapshot';
  snapshot: SessionSnapshotPojo;
  tsMs: number;
  gap: boolean;
}

export type SessionDeltaChangePojo =
  | { kind: 'state_changed'; state: ProtoSessionStateNumeric }
  | { kind: 'title_changed'; title: string }
  | { kind: 'cwd_changed'; fromCwd: string; toCwd: string }
  | { kind: 'pid_changed'; pid: number }
  | { kind: 'exited'; exitCode: number; signal: string };

export interface SessionDeltaEventPojo {
  kind: 'delta';
  sessionId: string;
  seq: number;
  tsMs: number;
  change: SessionDeltaChangePojo;
}

export interface SessionHeartbeatEventPojo {
  kind: 'heartbeat';
  sessionId: string;
  tsMs: number;
  lastSeq: number;
  bootNonce: string;
}

export interface SessionBootChangedEventPojo {
  kind: 'boot_changed';
  sessionId: string;
  bootNonce: string;
  snapshotPending: boolean;
}

export type SessionEventPojo =
  | SessionSnapshotEventPojo
  | SessionDeltaEventPojo
  | SessionHeartbeatEventPojo
  | SessionBootChangedEventPojo;

// ---------------------------------------------------------------------------
// Mutable per-session state
// ---------------------------------------------------------------------------

export interface SessionInit {
  sessionId: string;
  cwd: string;
  spawnCwd?: string;
  spawnedAtMs?: number;
  pid?: number;
  /** Initial state — defaults to `running` (matches inference.ts default
   *  for empty / not-yet-parseable JSONL). */
  initialState?: WatcherState;
  /** Initial title — defaults to empty string (no SDK-derived summary
   *  yet). */
  initialTitle?: string;
}

interface PerSession {
  sessionId: string;
  seq: number;
  state: WatcherState;
  title: string;
  cwd: string;
  spawnCwd: string;
  spawnedAtMs: number;
  pid: number;
  exited: boolean;
}

/**
 * Per-session snapshot + delta producer. Pure state-machine; emits
 * `SessionEventPojo` via the supplied `emit` callback. Holds the only
 * authoritative copy of (state, title, cwd, pid) for the session — all
 * Connect subscribers re-derive their view from these emits.
 */
export class SessionStateMachine {
  private rows = new Map<string, PerSession>();
  private emit: (evt: SessionEventPojo) => void;
  private bootNonce: string;

  constructor(opts: {
    emit: (evt: SessionEventPojo) => void;
    /** ULID minted at daemon supervisor boot (frag-6-7 §6.5). Used in
     *  every `SessionHeartbeatEvent` and `SessionBootChangedEvent`
     *  payload so subscribers can detect a daemon restart. */
    bootNonce: string;
  }) {
    this.emit = opts.emit;
    this.bootNonce = opts.bootNonce;
  }

  // ---- session lifecycle ----

  /** Register a fresh session. Idempotent: re-init with the same
   *  sessionId is a no-op (the existing snapshot wins; the upstream
   *  PTY layer is the source of truth for "this session exists"). */
  initSession(init: SessionInit): SessionSnapshotPojo {
    const existing = this.rows.get(init.sessionId);
    if (existing) return this.snapshotOf(existing);
    const row: PerSession = {
      sessionId: init.sessionId,
      seq: 0,
      state: init.initialState ?? 'running',
      title: init.initialTitle ?? '',
      cwd: init.cwd,
      spawnCwd: init.spawnCwd ?? init.cwd,
      spawnedAtMs: init.spawnedAtMs ?? Date.now(),
      pid: init.pid ?? 0,
      exited: false,
    };
    this.rows.set(init.sessionId, row);
    return this.snapshotOf(row);
  }

  /** Hard-remove a session row. Subscribers should drain themselves
   *  via the `SessionExited` delta first; this is the post-drain
   *  cleanup. No event is emitted. */
  removeSession(sessionId: string): void {
    this.rows.delete(sessionId);
  }

  hasSession(sessionId: string): boolean {
    return this.rows.has(sessionId);
  }

  /** All currently-tracked session ids. Snapshot order is map-insert
   *  order, matching `ListSessions` semantics. */
  sessionIds(): string[] {
    return [...this.rows.keys()];
  }

  /** Read-only snapshot for `GetSessionState` / `ListSessions` /
   *  fresh subscribe. */
  getSnapshot(sessionId: string): SessionSnapshotPojo | null {
    const row = this.rows.get(sessionId);
    if (!row) return null;
    return this.snapshotOf(row);
  }

  /** All snapshots, for `ListSessions`. */
  allSnapshots(): SessionSnapshotPojo[] {
    return [...this.rows.values()].map((r) => this.snapshotOf(r));
  }

  // ---- state mutations (each may emit at most one delta) ----

  /** Apply a watcher-derived state. No-op if unchanged (last-writer-
   *  wins is by-value here — the producer already deduped, but defense
   *  in depth never hurts). */
  applyState(sessionId: string, next: WatcherState): void {
    const row = this.rows.get(sessionId);
    if (!row || row.exited) return;
    if (row.state === next) return;
    row.state = next;
    row.seq += 1;
    this.emit({
      kind: 'delta',
      sessionId,
      seq: row.seq,
      tsMs: Date.now(),
      change: { kind: 'state_changed', state: toProtoSessionState(next) },
    });
  }

  /** Apply a watcher-derived title. No-op if unchanged or empty. */
  applyTitle(sessionId: string, next: string): void {
    const row = this.rows.get(sessionId);
    if (!row || row.exited) return;
    if (next === '' || row.title === next) return;
    row.title = next;
    row.seq += 1;
    this.emit({
      kind: 'delta',
      sessionId,
      seq: row.seq,
      tsMs: Date.now(),
      change: { kind: 'title_changed', title: next },
    });
  }

  /** Apply a cwd redirect (PTY emits this when the user `cd`s out of
   *  the spawn cwd, or when the import-helper relocates the JSONL into
   *  a new project dir — see #603). Emits even if same-value? No;
   *  same-value is a producer bug, deduped here. */
  applyCwd(sessionId: string, next: string): void {
    const row = this.rows.get(sessionId);
    if (!row || row.exited) return;
    if (row.cwd === next) return;
    const fromCwd = row.cwd;
    row.cwd = next;
    row.seq += 1;
    this.emit({
      kind: 'delta',
      sessionId,
      seq: row.seq,
      tsMs: Date.now(),
      change: { kind: 'cwd_changed', fromCwd, toCwd: next },
    });
  }

  /** Apply a PID change (rare — initial spawn carries pid=0 in some
   *  flows and is filled in once the PTY's child reports). */
  applyPid(sessionId: string, next: number): void {
    const row = this.rows.get(sessionId);
    if (!row || row.exited) return;
    if (row.pid === next) return;
    row.pid = next;
    row.seq += 1;
    this.emit({
      kind: 'delta',
      sessionId,
      seq: row.seq,
      tsMs: Date.now(),
      change: { kind: 'pid_changed', pid: next },
    });
  }

  /** Mark the session as exited and emit the terminal `SessionExited`
   *  delta. Subsequent applyX calls are no-ops; the row is kept around
   *  so a late subscriber's snapshot still reflects "exited" (matches
   *  the proto SessionState.EXITED enum value, see common.proto). */
  applyExit(sessionId: string, exitCode: number, signal: string): void {
    const row = this.rows.get(sessionId);
    if (!row || row.exited) return;
    row.exited = true;
    row.seq += 1;
    this.emit({
      kind: 'delta',
      sessionId,
      seq: row.seq,
      tsMs: Date.now(),
      change: { kind: 'exited', exitCode, signal },
    });
  }

  // ---- snapshot helpers ----

  /** Heartbeat — no state change, just a keepalive frame. The producer
   *  is the timer that lives in the Connect handler / subscriber, NOT
   *  this state machine; this method is exposed so the timer can route
   *  through the same emit sink for log/test parity. */
  emitHeartbeat(sessionId: string): void {
    const row = this.rows.get(sessionId);
    if (!row) return;
    this.emit({
      kind: 'heartbeat',
      sessionId,
      tsMs: Date.now(),
      lastSeq: row.seq,
      bootNonce: this.bootNonce,
    });
  }

  /** Boot-changed — emitted by the per-connection bootNonce comparator
   *  inside the Connect handler when the client supplied a stale
   *  `from_boot_nonce` on resubscribe. */
  emitBootChanged(sessionId: string, snapshotPending: boolean): void {
    this.emit({
      kind: 'boot_changed',
      sessionId,
      bootNonce: this.bootNonce,
      snapshotPending,
    });
  }

  private snapshotOf(row: PerSession): SessionSnapshotPojo {
    return {
      sessionId: row.sessionId,
      seq: row.seq,
      state: row.exited ? 4 : toProtoSessionState(row.state),
      title: row.title,
      cwd: row.cwd,
      spawnCwd: row.spawnCwd,
      spawnedAtMs: row.spawnedAtMs,
      pid: row.pid,
    };
  }
}
