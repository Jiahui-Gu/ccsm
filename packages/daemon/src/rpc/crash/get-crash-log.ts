// packages/daemon/src/rpc/crash/get-crash-log.ts
//
// Wave-3 Task #229 (sub-task 2 of audit #228) — production CrashService.GetCrashLog
// Connect handler.
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #2). Pre-#229 the entire `CrashService` was registered as an
// empty stub against the Connect router (`router.ts:STUB_SERVICES`),
// returning Connect `Code.Unimplemented` for every method despite the
// `crash_log` SQLite table being populated end-to-end at boot
// (`replayCrashRawOnBoot` -> `crash_log`). This file ships the unary
// `GetCrashLog` handler; sibling sub-tasks own the streaming RPCs
// (#334 GetRawCrashLog, #335 WatchCrashLog).
//
// Spec refs:
//   - packages/proto/src/ccsm/v1/crash.proto (forever-stable wire shape:
//     `int32 limit` capped at 1000, `int64 since_unix_ms` is a >= floor,
//     `OwnerFilter owner_filter` with UNSPECIFIED == OWN per the enum
//     comment).
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §5 (request shape + 1000-row server cap).
//     ch07 §3 + db/migrations/001_initial.sql (crash_log table layout +
//     `idx_crash_log_recent` and `idx_crash_log_owner_recent` indices we
//     deliberately rely on for ts-DESC ordering).
//     ch09 §1 (`'daemon-self'` owner sentinel; principalKey for
//     session-attributable rows).
//   - packages/daemon/test/integration/crash-getlog.spec.ts already
//     pins the over-the-wire semantics this handler implements end-to-end
//     against an in-memory store; this file is the production binding
//     to the real SQLite-backed `crash_log` table that the e2e harness
//     was holding the seat for.
//
// SRP layering — three roles kept separate (dev.md §2):
//   * decider:  `decideGetCrashLogQuery(req)` — pure function that maps
//               the wire request shape onto the in-process query plan
//               (server-side limit cap, since-floor coercion). No DB
//               access, no clocks, no principal lookup.
//   * producer: `readCrashLog(deps, plan)` — single SQL statement that
//               reads from `crash_log` honoring the decider's output.
//               Owner filter is applied in SQL because both indexes
//               (`idx_crash_log_recent` + `idx_crash_log_owner_recent`)
//               are ts-DESC-sorted; pushing the filter into SQL lets
//               the planner use `idx_crash_log_owner_recent` for OWN
//               and the recent index for ALL.
//   * sink:     `makeGetCrashLogHandler(deps)` — Connect handler that
//               reads the principal, runs the decider, calls the
//               producer, and maps each row into a proto `CrashEntry`.
//
// Layer 1 — alternatives checked:
//   - "wrap an existing reader" (per the task brief): no reader exists
//     today. `crash/raw-appender.ts` only WRITES to `crash_log` (boot
//     replay path); `crash/pruner.ts` only DELETES (retention).
//     Constructing the reader here is the smallest single-concern
//     addition; once Wave-4 lands a `CrashStore` (proposed under #335
//     for the WatchCrashLog stream that needs an event bus around the
//     write path), this handler becomes a one-line delegate.
//   - SQL pagination via `LIMIT ... OFFSET`: rejected — the request
//     shape ships only `(since_unix_ms, limit)`. Spec ch04 §5 wording
//     pins the `since_unix_ms`-as-cursor contract; OFFSET is forever
//     forbidden by that wording (would change the wire semantics).
//   - Server-side dropping of foreign-owner rows in TS rather than SQL:
//     rejected — see producer note above. SQL-side filter is one less
//     row over the wire from SQLite to Node and uses an index.
//   - ULID generation / id-based filtering: out of scope. The wire shape
//     does not expose row ids as cursor input; ULIDs land via the
//     write path and are returned in the response unchanged.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  CrashEntrySchema,
  type CrashService,
  GetCrashLogResponseSchema,
  OwnerFilter,
  type GetCrashLogRequest,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, principalKey, type Principal } from '../../auth/index.js';
import { DAEMON_SELF } from '../../crash/sources.js';
import type { SqliteDatabase } from '../../db/sqlite.js';
import { throwError } from '../errors.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Hard server-side cap on `limit` (spec ch04 §5 — forever-stable). */
export const SERVER_LIMIT_CAP = 1000;

// ---------------------------------------------------------------------------
// Decider
// ---------------------------------------------------------------------------

/**
 * Resolved query plan after applying spec-mandated coercions to the wire
 * request. Pure data; the producer turns this into one SQL statement.
 *
 * `effectiveLimit` is the post-cap value: spec ch04 §5 caps at 1000;
 * additionally a non-positive `limit` (proto3 default `0` for `int32`)
 * is normalised to the cap so a client that omits `limit` gets the
 * largest legal page rather than zero rows. The behaviour matches the
 * already-pinned integration spec (`crash-getlog.spec.ts:138-139`:
 * `limit > 0 ? limit : SERVER_LIMIT_CAP`).
 */
export interface GetCrashLogPlan {
  readonly sinceUnixMs: number;
  readonly effectiveLimit: number;
  readonly ownerFilter: OwnerFilter;
}

/**
 * Pure decider over the wire request. Translates `int64`/`int32` wire
 * fields into safe in-process JS numbers (the `crash_log.ts_ms` column
 * is INTEGER; values are unix-ms which fit in Number precision until
 * year 287396, far past v0.3's lifecycle).
 *
 * Out-of-range `limit` → cap. Negative `since_unix_ms` is coerced to 0
 * (defensive — proto3 allows negative int64 but the column never holds
 * a negative value).
 */
export function decideGetCrashLogQuery(req: GetCrashLogRequest): GetCrashLogPlan {
  const rawLimit = req.limit;
  const effectiveLimit =
    rawLimit > 0 && rawLimit < SERVER_LIMIT_CAP ? rawLimit : SERVER_LIMIT_CAP;
  const rawSince = Number(req.sinceUnixMs);
  const sinceUnixMs = Number.isFinite(rawSince) && rawSince > 0 ? rawSince : 0;
  return {
    sinceUnixMs,
    effectiveLimit,
    ownerFilter: req.ownerFilter,
  };
}

// ---------------------------------------------------------------------------
// Producer — SQL reader
// ---------------------------------------------------------------------------

/**
 * Row shape returned by `crash_log` SELECT. Mirrors the columns from
 * `db/migrations/001_initial.sql` `crash_log` table; `labels_json` is a
 * raw JSON string at this layer (parsed in the sink).
 */
interface CrashLogRow {
  readonly id: string;
  readonly ts_ms: number;
  readonly source: string;
  readonly summary: string;
  readonly detail: string;
  readonly labels_json: string;
  readonly owner_id: string;
}

export interface GetCrashLogDeps {
  /** Open `crash_log` SQLite handle. Same instance the rest of the
   *  daemon uses (single owner of the DB; see `index.ts` runStartup). */
  readonly db: SqliteDatabase;
}

/**
 * Read at most `plan.effectiveLimit` rows from `crash_log` newer-than-or-equal
 * to `plan.sinceUnixMs`, applying the owner filter.
 *
 * Owner filter mapping (spec ch04 §5 + crash.proto OwnerFilter comment):
 *   - UNSPECIFIED (default) == OWN
 *   - OWN  → rows where `owner_id` equals the caller's principalKey OR
 *            equals the `'daemon-self'` sentinel.
 *   - ALL  → no owner filter; v0.3 daemon's authorization layer SHOULD
 *            restrict this to admin principals, but the wire shape allows
 *            it. Until the admin-principal scaffolding lands (v0.4) we
 *            honor the request as-is — the integration spec
 *            `crash-getlog.spec.ts` "ALL filter is broader than OWN"
 *            test pins this behavior.
 */
export function readCrashLog(
  deps: GetCrashLogDeps,
  plan: GetCrashLogPlan,
  callerKey: string,
): readonly CrashLogRow[] {
  const widen = plan.ownerFilter === OwnerFilter.ALL;
  // Two prepared shapes — separate so the planner picks the right
  // index for each (`idx_crash_log_owner_recent` for OWN's
  // `owner_id IN (...)` clause, `idx_crash_log_recent` for ALL).
  if (widen) {
    const stmt = deps.db.prepare<[number, number]>(
      `SELECT id, ts_ms, source, summary, detail, labels_json, owner_id
         FROM crash_log
        WHERE ts_ms >= ?
        ORDER BY ts_ms DESC, id DESC
        LIMIT ?`,
    );
    return stmt.all(plan.sinceUnixMs, plan.effectiveLimit) as readonly CrashLogRow[];
  }
  const stmt = deps.db.prepare<[number, string, string, number]>(
    `SELECT id, ts_ms, source, summary, detail, labels_json, owner_id
       FROM crash_log
      WHERE ts_ms >= ?
        AND owner_id IN (?, ?)
      ORDER BY ts_ms DESC, id DESC
      LIMIT ?`,
  );
  return stmt.all(
    plan.sinceUnixMs,
    callerKey,
    DAEMON_SELF,
    plan.effectiveLimit,
  ) as readonly CrashLogRow[];
}

// ---------------------------------------------------------------------------
// Sink — Connect handler
// ---------------------------------------------------------------------------

/**
 * Map a SQL row into the proto `CrashEntry` shape. `labels_json` is
 * stored as JSON text; we parse defensively (a corrupt row should not
 * fail the whole page — surface an empty labels map and the row's
 * other fields).
 */
function rowToProto(row: CrashLogRow): ReturnType<typeof create<typeof CrashEntrySchema>> {
  let labels: Record<string, string> = {};
  try {
    const parsed = JSON.parse(row.labels_json);
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      labels = {};
      for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof v === 'string') labels[k] = v;
      }
    }
  } catch {
    // Corrupt JSON — keep `labels` empty; the rest of the row is still
    // useful for the operator viewing the crash log.
  }
  return create(CrashEntrySchema, {
    id: row.id,
    tsUnixMs: BigInt(row.ts_ms),
    source: row.source,
    summary: row.summary,
    detail: row.detail,
    labels,
    ownerId: row.owner_id,
  });
}

/**
 * Build the Connect `ServiceImpl<typeof CrashService>['getCrashLog']`
 * handler. Reads `PRINCIPAL_KEY` from the HandlerContext (the
 * `peerCredAuthInterceptor` deposited it before the handler runs),
 * runs the decider over the request, then queries `crash_log` and
 * maps rows to the wire shape.
 *
 * Mirrors the posture of `sessions/watch-sessions.ts:makeWatchSessionsHandler`:
 * a missing principal is a daemon wiring bug surfaced as `Internal`
 * rather than `Unauthenticated` (the auth interceptor would have
 * rejected the call before this handler ran if the caller were
 * unauthenticated).
 */
export function makeGetCrashLogHandler(
  deps: GetCrashLogDeps,
): ServiceImpl<typeof CrashService>['getCrashLog'] {
  return async function getCrashLog(
    req,
    ctx: HandlerContext,
  ) {
    const principal: Principal | null = ctx.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'GetCrashLog handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }
    const plan = decideGetCrashLogQuery(req);
    // Spec ch15 §3 #14: OwnerFilter / SettingsScope / WatchScope MUST
    // reject the broadened values (ALL / PRINCIPAL) on v0.3 with
    // PermissionDenied. ALL is reserved for v0.4 admin principals; the
    // wire shape allows it but the v0.3 daemon's authorization layer
    // refuses it — single source of truth alongside
    // `sessions/watch-sessions.ts:decideWatchScope` (which rejects
    // WATCH_SCOPE_ALL with the same `session.not_owned` ErrorDetail).
    if (plan.ownerFilter === OwnerFilter.ALL) {
      throwError(
        'session.not_owned',
        'OWNER_FILTER_ALL is not permitted on v0.3 (admin scope reserved for v0.4 — spec ch15 §3 #14)',
        { requested_owner_filter: 'ALL' },
      );
    }
    // Defensive: reject unknown enum values rather than silently treating
    // them as OWN. Mirrors the `decideWatchScope` posture in
    // sessions/watch-sessions.ts (forward-compat: a v0.4 client speaking
    // a higher proto_version may send an enum the v0.3 daemon does not
    // know; conservative deny is the contract).
    if (
      plan.ownerFilter !== OwnerFilter.UNSPECIFIED &&
      plan.ownerFilter !== OwnerFilter.OWN
    ) {
      throwError(
        'session.not_owned',
        `unknown OwnerFilter enum value ${String(plan.ownerFilter)} — refusing to interpret`,
        { requested_owner_filter: String(plan.ownerFilter) },
      );
    }
    const callerKey = principalKey(principal);
    const rows = readCrashLog(deps, plan, callerKey);
    return create(GetCrashLogResponseSchema, {
      // Echo the request meta back unchanged. The client correlates
      // request_id round-trip per spec ch04 §2; mutating to a different
      // id would break that contract. A test that needs to assert
      // server-emitted meta should send a request meta with the
      // expected fields.
      meta: req.meta,
      entries: rows.map(rowToProto),
    });
  };
}
