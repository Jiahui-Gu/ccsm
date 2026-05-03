// SessionManager — daemon-side owner of session lifecycle.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch05 §5 (per-RPC enforcement matrix)
//     ch05 §6 (session create flow)
//     ch07 §3 (sessions table schema)
//
// T3.2 scope:
//   - In-process owner of CRUD over the `sessions` table.
//   - Owns the in-memory event bus subscription surface (see event-bus.ts).
//   - Pure backend: NO RPC plumbing, NO IPC, NO PTY spawn. The
//     SessionService Connect handler (T3.3 / T3.4) wraps this manager and
//     maps proto messages -> manager calls -> proto responses.
//   - PTY spawn / xterm-headless host wiring lands in T4.x and will hook
//     into the manager via a separate `attachPtyHost(...)` entry point;
//     v0.3 ship-level wiring lands in a follow-up task.
//
// SRP discipline (dev.md §3):
//   - producer (`buildSessionRow`): pure function, builds a `SessionRow`
//     from the request input + principal + clock + id generator. No DB,
//     no event bus.
//   - decider (`assertOwnership`, in-flight): pure ownership check that
//     throws the canonical `session.not_owned` ConnectError; reused by
//     `get` and `destroy`.
//   - sink (`SessionManager` class): owns the SQLite handle and the
//     event bus, calls into the producer + decider, and is the only
//     place in the file with side effects.
//
// Layer 1 — alternatives checked:
//   - Reuse `node:events.EventEmitter`: rejected, see event-bus.ts.
//   - Reuse a `kysely` / `drizzle` query builder: rejected — the spec
//     ch07 §1 mandates better-sqlite3 sync driver and the existing
//     daemon code uses raw prepared statements. Adding a query builder
//     would diverge from the existing pattern (see crash/raw-appender,
//     db/recovery) and cost a transitive dep.
//   - Add the `ulid` npm package: rejected per spec ch09 §1 footnote
//     ("we do NOT add a `ulid` npm dep") and existing daemon practice
//     in `crash/sources.ts:newCrashId`. We synthesize a 26-char,
//     Crockford-base32, lexicographically-sortable id locally — the
//     same property a real ULID provides for index locality on the
//     `sessions(id)` PRIMARY KEY.

import { randomBytes } from 'node:crypto';

import type { Principal } from '../auth/principal.js';
import { principalKey } from '../auth/principal.js';
import type { SqliteDatabase } from '../db/sqlite.js';
import { throwError } from '../rpc/errors.js';

import { SessionEventBus, type SessionEventListener, type Unsubscribe } from './event-bus.js';
import {
  SessionState,
  type CreateSessionInput,
  type SessionRow,
  type SessionStateValue,
} from './types.js';

// ---------------------------------------------------------------------------
// ULID-shaped id generator (local; no `ulid` dep — see Layer 1 note above).
//
// Format: 10 chars Crockford-base32 of 48-bit unix-ms time + 16 chars
// Crockford-base32 of 80 bits randomness = 26 chars total. Same shape and
// lexicographic property as a real ULID per ulid spec
// (https://github.com/ulid/spec). The randomness comes from
// `crypto.randomBytes(10)` (CSPRNG).
//
// Monotonicity within the same ms is NOT guaranteed (a real ulid library
// would seed the random part and bump on collision). The spec does not
// require monotonicity for `sessions.id` (chapter 07 §3 just says
// "lexicographically time-ordered, 26 chars"); 80 bits of CSPRNG makes the
// in-millisecond collision probability negligible for the daemon's
// single-process write rate.
// ---------------------------------------------------------------------------

const CROCKFORD_BASE32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function encodeBase32(bytes: Uint8Array, length: number): string {
  // Encode `bytes` (MSB-first) into `length` Crockford-base32 chars by
  // pulling 5-bit groups from the high end. We build the string from the
  // tail forward so we can divide-by-32 from a bigint without copying.
  let value = 0n;
  for (const b of bytes) value = (value << 8n) | BigInt(b);
  let out = '';
  for (let i = 0; i < length; i++) {
    out = CROCKFORD_BASE32[Number(value & 0x1fn)] + out;
    value >>= 5n;
  }
  return out;
}

function encodeTime(ms: number): string {
  // 48-bit time -> 10 base32 chars. Throw on negative or out-of-range so a
  // misconfigured clock surfaces immediately rather than producing an id
  // with bogus prefix that mis-sorts later.
  if (!Number.isInteger(ms) || ms < 0 || ms > 0xffff_ffff_ffff) {
    throw new RangeError(`session id timestamp out of 48-bit range: ${ms}`);
  }
  const bytes = new Uint8Array(6);
  let v = ms;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = v & 0xff;
    v = Math.floor(v / 256);
  }
  return encodeBase32(bytes, 10);
}

/**
 * Default id generator — exported so tests / fixtures can swap it for a
 * deterministic stub via `SessionManagerOptions.newId`.
 */
export function newSessionId(now: () => number = Date.now): string {
  const tsPart = encodeTime(now());
  const randPart = encodeBase32(randomBytes(10), 16);
  return tsPart + randPart;
}

// ---------------------------------------------------------------------------
// Producer — pure construction of a SessionRow from inputs.
// ---------------------------------------------------------------------------

/**
 * Build a `SessionRow` for INSERT. Pure — no DB, no event-bus side
 * effects. Exported so unit tests can pin the row shape independently of
 * the SessionManager's persistence layer.
 *
 * Defaults per spec ch05 §6 + ch07 §3:
 *   - state              = STARTING  (transitioned to RUNNING by T4.x once
 *                                     PTY is wired; v0.3 SessionManager only
 *                                     ships the create-time STARTING row)
 *   - exit_code          = -1        (sentinel from 001_initial.sql)
 *   - should_be_running  = 1         (Destroy flips to 0 — ch07 §3 comment)
 *   - created_ms         = now
 *   - last_active_ms     = now
 */
export function buildSessionRow(
  input: CreateSessionInput,
  principal: Principal,
  id: string,
  now: number,
): SessionRow {
  return {
    id,
    owner_id: principalKey(principal),
    state: SessionState.STARTING,
    cwd: input.cwd,
    env_json: input.env_json,
    claude_args_json: input.claude_args_json,
    geometry_cols: input.geometry_cols,
    geometry_rows: input.geometry_rows,
    exit_code: -1,
    created_ms: now,
    last_active_ms: now,
    should_be_running: 1,
  };
}

// ---------------------------------------------------------------------------
// Decider — ownership check.
// ---------------------------------------------------------------------------

/**
 * Throws `session.not_owned` (Code.PermissionDenied) if `caller` does not
 * own `row`. Pure — does not log, does not metric. The interceptor / log
 * appender (T9.x) attaches structured-log emission around the throw.
 *
 * Spec ch05 §4: "The check is NOT delegated to SQL — it is an explicit
 * early return because (a) Listing RPCs filter by owner_id in SQL, but
 * get/update/destroy RPCs take a session_id from the client; an SQL-only
 * filter would return 'not found' instead of 'permission denied', and we
 * want the distinction in logs."
 */
function assertRowOwned(caller: Principal, row: SessionRow): void {
  const callerKey = principalKey(caller);
  if (row.owner_id !== callerKey) {
    throwError('session.not_owned', undefined, { session_id: row.id });
  }
}

// ---------------------------------------------------------------------------
// Sink — the SessionManager class.
// ---------------------------------------------------------------------------

export interface SessionManagerOptions {
  /** Override the wall clock — tests pass a controllable stub. */
  readonly now?: () => number;
  /** Override the id generator — tests pass a deterministic counter. */
  readonly newId?: () => string;
  /** Override the event-bus instance — tests inject a spy. */
  readonly eventBus?: SessionEventBus;
}

/**
 * Manager interface — exported so the SessionService handler (T3.3) can
 * type-depend on the surface without taking a concrete-class import.
 * Mirrors the v0.3 RPCs from spec ch05 §5 (Create / Get / List /
 * Destroy / WatchSessions). WatchSessions is exposed here as
 * `subscribe`; the handler adapts that into the gRPC server-streaming
 * call.
 */
export interface ISessionManager {
  create(input: CreateSessionInput, caller: Principal): SessionRow;
  get(id: string, caller: Principal): SessionRow;
  list(caller: Principal): readonly SessionRow[];
  destroy(id: string, caller: Principal): SessionRow;
  subscribe(caller: Principal, listener: SessionEventListener): Unsubscribe;
}

/**
 * SQL fragments — kept as `const` so prepared statements are cached on
 * the better-sqlite3 driver. Column order matches `SessionRow` so the
 * INSERT bindings line up with the row shape.
 */
const SQL_INSERT = `INSERT INTO sessions (
  id, owner_id, state, cwd, env_json, claude_args_json,
  geometry_cols, geometry_rows, exit_code, created_ms, last_active_ms,
  should_be_running
) VALUES (
  @id, @owner_id, @state, @cwd, @env_json, @claude_args_json,
  @geometry_cols, @geometry_rows, @exit_code, @created_ms, @last_active_ms,
  @should_be_running
)`;

const SQL_SELECT_BY_ID = `SELECT id, owner_id, state, cwd, env_json, claude_args_json,
  geometry_cols, geometry_rows, exit_code, created_ms, last_active_ms,
  should_be_running
  FROM sessions WHERE id = ?`;

const SQL_SELECT_BY_OWNER = `SELECT id, owner_id, state, cwd, env_json, claude_args_json,
  geometry_cols, geometry_rows, exit_code, created_ms, last_active_ms,
  should_be_running
  FROM sessions WHERE owner_id = ? ORDER BY created_ms ASC, id ASC`;

const SQL_UPDATE_DESTROY = `UPDATE sessions
  SET state = @state, should_be_running = 0, last_active_ms = @last_active_ms
  WHERE id = @id`;

export class SessionManager implements ISessionManager {
  private readonly db: SqliteDatabase;
  private readonly now: () => number;
  private readonly newId: () => string;
  private readonly bus: SessionEventBus;

  constructor(db: SqliteDatabase, options: SessionManagerOptions = {}) {
    this.db = db;
    this.now = options.now ?? Date.now;
    this.newId = options.newId ?? (() => newSessionId(this.now));
    this.bus = options.eventBus ?? new SessionEventBus();
  }

  /**
   * Create a session for `caller`. Spec ch05 §6:
   *   1. id := ULID()
   *   2. owner_id := principalKey(principal)
   *   3. INSERT row with state=STARTING.
   *   4. emit `SessionEvent.created` on the bus.
   *
   * Returns the persisted row so the handler can render the proto
   * `Session` immediately. PTY spawn + state transition to RUNNING is
   * out of scope for this PR (T4.x).
   */
  create(input: CreateSessionInput, caller: Principal): SessionRow {
    const now = this.now();
    const id = this.newId();
    const row = buildSessionRow(input, caller, id, now);
    this.db.prepare(SQL_INSERT).run(row);
    this.bus.publish({ kind: 'created', session: row });
    return row;
  }

  /**
   * Fetch a session by id. Spec ch05 §5: load by id; `assertOwnership`;
   * then return. A missing row throws `Code.NotFound` so the caller can
   * distinguish "no such session" from "not yours".
   */
  get(id: string, caller: Principal): SessionRow {
    const row = this.loadRow(id);
    assertRowOwned(caller, row);
    return row;
  }

  /**
   * List the caller's sessions. Spec ch05 §5: SQL `WHERE owner_id = ?`
   * with `principalKey(ctx.principal)`; **no per-row check** because no
   * row escapes the filter. The principalKey filter is unconditional
   * (security boundary, per task constraints) — a future "admin
   * cross-principal list" lands as a NEW method, not a flag here.
   */
  list(caller: Principal): readonly SessionRow[] {
    const ownerKey = principalKey(caller);
    return this.db.prepare(SQL_SELECT_BY_OWNER).all(ownerKey) as SessionRow[];
  }

  /**
   * Destroy a session. Spec ch05 §5: load by id; `assertOwnership`; then
   * delete + tear down PTY + kill claude CLI. PTY/CLI teardown lands in
   * T4.x; T3.2 ships the row-state change + `should_be_running = 0` so
   * the daemon's restore-on-boot loop skips it (ch05 §7), and emits
   * `SessionEvent.destroyed`.
   *
   * The row is updated rather than deleted (chapter 07 §3 retains the
   * row for crash-log / audit cross-reference; a future GC task may
   * prune EXITED rows older than a retention window).
   */
  destroy(id: string, caller: Principal): SessionRow {
    const row = this.loadRow(id);
    assertRowOwned(caller, row);
    const now = this.now();
    const newState: SessionStateValue = SessionState.EXITED;
    this.db.prepare(SQL_UPDATE_DESTROY).run({
      id: row.id,
      state: newState,
      last_active_ms: now,
    });
    const destroyed: SessionRow = {
      ...row,
      state: newState,
      should_be_running: 0,
      last_active_ms: now,
    };
    this.bus.publish({ kind: 'destroyed', session: destroyed });
    return destroyed;
  }

  /**
   * Subscribe to lifecycle events scoped to `caller`. Returns an
   * unsubscribe handle. The bus filters on `principalKey(caller)`
   * before delivery — subscribers cannot observe other principals'
   * events even if the predicate is buggy (security boundary).
   */
  subscribe(caller: Principal, listener: SessionEventListener): Unsubscribe {
    return this.bus.subscribe(principalKey(caller), listener);
  }

  /**
   * Test/observability hook: expose the underlying bus so a higher
   * layer (T3.3 WatchSessions handler) can pass it through, and unit
   * tests can assert listener counts. NOT part of the
   * `ISessionManager` interface — handlers should go through
   * `subscribe`, not the bus directly.
   */
  get eventBus(): SessionEventBus {
    return this.bus;
  }

  /**
   * Load a row by id, throwing `session.not_owned` when the row is
   * absent. Spec ch05 §4 / §5: we deliberately do NOT distinguish
   * "row missing" from "row owned by a different principal" at the
   * RPC layer — leaking existence-of-id across principals would let
   * one user enumerate another user's session ids by probing for
   * Code.NotFound vs Code.PermissionDenied. Both paths emit
   * `session.not_owned`. (If a v0.4 admin RPC needs the distinction,
   * it lands as a separate method.)
   */
  private loadRow(id: string): SessionRow {
    const row = this.db.prepare(SQL_SELECT_BY_ID).get(id) as SessionRow | undefined;
    if (row === undefined) {
      throwError('session.not_owned', undefined, { session_id: id });
    }
    return row;
  }
}
