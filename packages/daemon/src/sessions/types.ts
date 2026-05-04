// In-process session types — INTERNAL to the daemon. NOT proto types.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch05 §5 (per-RPC enforcement matrix), §6 (session create flow),
//     ch07 §3 (sessions table schema).
//
// Design notes (T3.2 / Task #38):
//   - These types model the SQLite `sessions` row 1:1 (chapter 07 §3 schema).
//     The fields use snake_case to mirror the column names, so the
//     better-sqlite3 prepared-statement bindings are positional and the
//     `SELECT * FROM sessions` row maps trivially with no rename layer.
//   - We deliberately do NOT import the proto-generated `Session` /
//     `SessionEvent` messages here. The SessionManager owns DB rows and
//     event-bus payloads; mapping the row to the proto `Session` happens at
//     the RPC handler layer (T3.3 / T3.4) — keeps the manager free of proto
//     plumbing per the SRP discipline (dev.md §3 "sink owns one side effect").
//   - `SessionState` is a number that mirrors the proto `SessionState` enum
//     int (chapter 07 §3 + common.proto: STARTING=1, RUNNING=2, EXITED=3,
//     CRASHED=4). v0.3 SessionManager currently emits STARTING on create and
//     transitions to a TERMINATED state on Destroy. Per spec ch05 §5 the
//     enum order is forever-stable; "TERMINATED" is NOT a separate enum
//     value — Destroy semantically maps to EXITED with `should_be_running=0`
//     so the daemon's restore-on-boot loop (ch05 §7) skips the row.
//   - `SessionEvent` is the in-memory union shape for the event bus. It is
//     intentionally minimal: each variant carries the full SessionRow so
//     subscribers (WatchSessions handler in T3.3) can render the proto
//     `SessionEvent` without re-querying the DB. Principal-scoping is done
//     by the bus before delivery — see event-bus.ts.

/**
 * Mirrors the proto `SessionState` enum int values from
 * `packages/proto/src/ccsm/v1/common.proto`. Re-declared as a `const` enum
 * here to keep the SessionManager free of proto imports (the proto value is
 * the wire contract; this constant is its numeric image inside the daemon).
 *
 * Forever-stable ordering per spec ch05 + common.proto:
 *   UNSPECIFIED=0, STARTING=1, RUNNING=2, EXITED=3, CRASHED=4
 */
export const SessionState = Object.freeze({
  UNSPECIFIED: 0,
  STARTING: 1,
  RUNNING: 2,
  EXITED: 3,
  CRASHED: 4,
} as const);

export type SessionStateValue = (typeof SessionState)[keyof typeof SessionState];

/**
 * A row in the `sessions` table (chapter 07 §3 schema). Field names mirror
 * the SQLite column names exactly — the SessionManager binds these into
 * `INSERT INTO sessions (...) VALUES (...)` positionally, and `SELECT *`
 * rows are returned as this shape with no renaming layer.
 *
 * `env_json` and `claude_args_json` are stored as TEXT in SQLite — we keep
 * the raw JSON string here rather than a parsed object to avoid double-
 * encoding round-trips and to keep the manager allocation-free on read.
 * Callers that need parsed values do so at the RPC boundary.
 *
 * `owner_id` is `principalKey(principal)` — see ch05 §1. It is the security
 * boundary on every Get/List/Destroy: the manager filters/asserts on this
 * column unconditionally.
 */
export interface SessionRow {
  readonly id: string;
  readonly owner_id: string;
  readonly state: SessionStateValue;
  readonly cwd: string;
  readonly env_json: string;
  readonly claude_args_json: string;
  readonly geometry_cols: number;
  readonly geometry_rows: number;
  readonly exit_code: number;
  readonly created_ms: number;
  readonly last_active_ms: number;
  readonly should_be_running: 0 | 1;
}

/**
 * Input shape for `SessionManager.create`. Everything the daemon needs from
 * a `CreateSessionRequest` after the RPC layer has unpacked the proto. We
 * do NOT take the proto type directly so the manager remains independent
 * of `@ccsm/proto` and is unit-testable without a proto fixture.
 *
 * `env` and `claude_args` are normalised to strings (JSON-encoded) before
 * being passed in; the producer (see `producer.ts`) handles the encode so
 * the manager itself is allocation-light.
 */
export interface CreateSessionInput {
  readonly cwd: string;
  /** Pre-encoded JSON object string. */
  readonly env_json: string;
  /** Pre-encoded JSON array string. */
  readonly claude_args_json: string;
  readonly geometry_cols: number;
  readonly geometry_rows: number;
}

/**
 * In-process event bus payload. One discriminated union variant per
 * lifecycle event. Each variant carries the full `SessionRow` so a
 * subscriber can render the proto `SessionEvent` immediately without a
 * DB round-trip.
 *
 * Spec ch05 §6 defines `created`; ch05 §5 (`DestroySession` row) defines
 * `destroyed`. v0.4 may extend with `state-changed` etc.; new variants
 * land as additional `kind` values without changing existing ones.
 */
export type SessionEvent =
  | { readonly kind: 'created'; readonly session: SessionRow }
  | { readonly kind: 'destroyed'; readonly session: SessionRow }
  /**
   * Lifecycle terminus for a session whose pty-host child exited
   * (graceful close OR crash). Spec ch06 §1: emitted by the daemon's
   * pty-host child-exit handler after it has killed any residual claude
   * subtree and flipped `should_be_running = 0`. The carried `session`
   * row reflects the post-update state (`state` ∈ {EXITED, CRASHED},
   * `exit_code` set, `should_be_running = 0`). Distinct from `destroyed`
   * (which is fired by an explicit DestroySession RPC, not a child exit)
   * so subscribers can distinguish "user closed" from "child died";
   * watch-sessions.ts maps both to the proto `updated` oneof case which
   * carries the full Session row.
   */
  | { readonly kind: 'ended'; readonly session: SessionRow; readonly reason: SessionEndedReason };

/**
 * Reason a session terminated via the pty-host child-exit path. Mirrors
 * `ChildExitReason` from `pty-host/types.ts` but is duplicated here so
 * the sessions module does NOT depend on the pty-host module's types
 * (the dependency direction is pty-host → sessions, never the reverse).
 */
export type SessionEndedReason = 'graceful' | 'crashed';
