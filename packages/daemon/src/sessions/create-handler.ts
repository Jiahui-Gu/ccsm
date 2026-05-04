// packages/daemon/src/sessions/create-handler.ts
//
// Wave-3 Task #339 — production SessionService.CreateSession Connect handler
// (audit #228 sub-task 6).
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #6). Pre-#339 SessionService.CreateSession was the T2.2 empty
// stub on the wire (`router.ts:STUB_SERVICES`), returning Connect
// `Code.Unimplemented` despite `SessionManager.create()` (T3.2 / #38)
// being fully implemented and unit-tested. This file is the thin adapter
// from the proto request shape onto `SessionManager.create()` and back to
// the proto `CreateSessionResponse`. Mirrors the read pair in
// `sessions/read-handlers.ts`, the destroy handler in
// `sessions/destroy-handler.ts` (Wave 3 §6.9 sub-task 7 / Task #338),
// and the WatchSessions stream handler in `sessions/watch-sessions.ts`
// (T3.3 / PR #939).
//
// Spec refs:
//   - packages/proto/src/ccsm/v1/session.proto
//     CreateSessionRequest = `{ meta, cwd, env, claude_args,
//     initial_geometry }`; CreateSessionResponse = `{ meta, session }`
//     where `session` is the just-persisted `Session` row in STARTING
//     state (the canonical post-create proto rendering — same mapper the
//     WatchSessions stream uses for `created` events).
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §3 (CreateSession unary RPC; principal-scoped via
//     peerCredAuthInterceptor + SessionManager.create's owner_id wiring;
//     the `Session.owner` echoed in the response is the caller's
//     LocalUser variant — same shape the WatchSessions `created` event
//     carries so a client that runs Create + WatchSessions in parallel
//     sees identical row attribution on both paths).
//     ch05 §6 (session create flow: id := ULID(), state := STARTING,
//     INSERT row, publish `created` event on the in-memory bus).
//
// SCOPE — Task #359 update:
//   - PTY spawn is now wired here via the optional `attachPtyHost` dep
//     (see `CreateSessionDeps` below). When supplied, the handler calls
//     `attachPtyHost(row, principal)` AFTER `manager.create` returns
//     the freshly-INSERTed row. The callback is FIRE-AND-FORGET: it
//     forks the per-session pty-host child (`spawnPtyHostChild`, T4.1)
//     and installs the lifecycle watcher (`watchPtyHostChildLifecycle`,
//     T4.4) so any child exit transitions the row to its terminal state
//     via `SessionManager.markEnded`. CreateSession DOES NOT block on
//     the child's `ready` IPC — the row is returned in STARTING state
//     and the pty-host bridge transitions it to RUNNING asynchronously
//     (spec ch05 §6 / ch06 §1).
//   - When `attachPtyHost` is omitted (existing test fixtures /
//     workflows that pre-date #359), the handler keeps the pre-#359
//     behavior: row is INSERTed + `created` published, no child fork.
//     Callers that want the row but no child (e.g. unit tests) just
//     omit the dep.
//   - Validation of cwd existence / executable resolution still lives
//     in the pty-host spawn path (#359's `attachPtyHost`), surfaced via
//     `SessionEvent.ended { reason='crashed' }` rather than synchronous
//     CreateSession errors — same alternatives-rejected logic as before.
//
// SRP layering — three roles kept separate (dev.md §2):
//   * decider:  `decodeCreateRequest(req)` — pure. Takes the proto
//               message and returns the manager's `CreateSessionInput`
//               (snake_case row shape, JSON-encoded env / args). No DB,
//               no event bus, no proto rendering. Exported so unit tests
//               can pin the encode independently.
//   * producer: `SessionManager.create(input, caller)` — already
//               implemented in T3.2 / #38; this handler does NOT ship a
//               new producer. The manager is the single source of truth
//               for the row INSERT + event-bus publish.
//   * sink:     `makeCreateSessionHandler(deps)` — Connect handler that
//               reads the principal from `HandlerContext`, calls the
//               decider + producer, and renders the proto
//               `CreateSessionResponse` via the existing
//               `sessionRowToProto` (same mapper the WatchSessions
//               stream uses — single proto-mapping seam).
//
// Layer 1 — alternatives checked:
//   - Re-implement row -> proto translation locally. Rejected:
//     `sessionRowToProto` from `watch-sessions.ts` is already the
//     canonical mapper (handles `LocalUser` owner attribution and the
//     `exit_code === -1` sentinel). Reusing it keeps a single mapper —
//     a future field addition only edits one place.
//   - Pass the proto `CreateSessionRequest` directly into
//     `SessionManager.create`. Rejected: the manager is intentionally
//     proto-agnostic (see `sessions/types.ts` header) so unit tests do
//     not need a proto fixture and the v0.3 / v0.4 wire shapes can
//     evolve independently of the in-process row shape. The adapter
//     (this file) is the right seam.
//   - Spawn the pty-host child inline as part of CreateSession. Rejected:
//     scope creep into Task #359 (see SCOPE note above).
//   - Validate cwd existence / readability inside the handler. Rejected
//     for v0.3: spec ch05 §6 places filesystem validation in the
//     pty-host spawn path (#359), not the unary RPC — Create returns the
//     STARTING row regardless of whether cwd is reachable, and the
//     pty-host's spawn failure surfaces via the `ended` event with
//     `reason='crashed'`. Coupling validation into the unary handler
//     would either duplicate the spawn path's check or let the two
//     diverge (classic dual source-of-truth bug).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  CreateSessionResponseSchema,
  type CreateSessionRequest,
  type SessionService,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';

import type { ISessionManager } from './SessionManager.js';
import type { CreateSessionInput, SessionRow } from './types.js';
import { sessionRowToProto } from './watch-sessions.js';

// ---------------------------------------------------------------------------
// Decider — proto request -> manager input (pure)
// ---------------------------------------------------------------------------

/**
 * Default geometry when the client omits `initial_geometry`. 80x24 is
 * the historical terminal default; the pty-host spawn (#359) re-emits a
 * resize event when the renderer measures its actual viewport so this
 * value is only the "before-first-resize" floor. Exported so tests can
 * pin the same default the production handler uses.
 */
export const DEFAULT_GEOMETRY_COLS = 80;
export const DEFAULT_GEOMETRY_ROWS = 24;

/**
 * Translate a proto `CreateSessionRequest` into the row-shape input that
 * `SessionManager.create` consumes.
 *
 * Encoding choices (mirrors `sessions/types.ts:CreateSessionInput`):
 *   - `env` (proto3 `map<string,string>`) is JSON-encoded to a stable
 *     stringified-object so the better-sqlite3 TEXT column round-trips
 *     without per-row parsing on read. The encode is deterministic
 *     because we sort keys before stringifying — keeps the on-disk
 *     bytes byte-identical for the same logical input across boots
 *     (helpful for crash/reboot row-equality checks).
 *   - `claude_args` (proto3 `repeated string`) is JSON-encoded as an
 *     array literal — order is part of the contract (argv positional
 *     semantics) so we do NOT sort.
 *   - `initial_geometry` is optional on the wire. When unset, we apply
 *     the 80x24 default (see DEFAULT_GEOMETRY_* above). When the client
 *     sets `cols` or `rows` to 0 we ALSO fall back to the default —
 *     a 0-dimension PTY would crash xterm-headless on first paint and
 *     surface as a confusing "session created then immediately died"
 *     to the user (the right semantics is "treat 0 as 'I don't care,
 *     use a sane default'").
 */
export function decodeCreateRequest(req: CreateSessionRequest): CreateSessionInput {
  // Sort env keys for deterministic JSON. proto3 `map<>` iteration order
  // is not guaranteed; sorted output is so a re-encode of the same map
  // produces byte-identical TEXT in SQLite.
  const sortedEnv: Record<string, string> = {};
  for (const key of Object.keys(req.env).sort()) {
    sortedEnv[key] = req.env[key];
  }
  const cols =
    req.initialGeometry && req.initialGeometry.cols > 0
      ? req.initialGeometry.cols
      : DEFAULT_GEOMETRY_COLS;
  const rows =
    req.initialGeometry && req.initialGeometry.rows > 0
      ? req.initialGeometry.rows
      : DEFAULT_GEOMETRY_ROWS;
  return {
    cwd: req.cwd,
    env_json: JSON.stringify(sortedEnv),
    claude_args_json: JSON.stringify(req.claudeArgs),
    geometry_cols: cols,
    geometry_rows: rows,
  };
}

// ---------------------------------------------------------------------------
// Sink — Connect handler
// ---------------------------------------------------------------------------

export interface CreateSessionDeps {
  readonly manager: ISessionManager;
  /**
   * Optional Task #359 hook: invoked AFTER `manager.create` returns the
   * freshly-INSERTed row. Production wires this to
   * `makeProductionAttachPtyHost({ manager })` from
   * `pty-host/attach-on-create.ts` — the callback forks a per-session
   * pty-host child (`spawnPtyHostChild`, T4.1 / #41) and installs the
   * lifecycle watcher (`watchPtyHostChildLifecycle`, T4.4 / #42) so the
   * row transitions to its terminal state when the child exits.
   *
   * The callback MUST be fire-and-forget: any error is its own
   * responsibility (the production factory routes errors to its
   * `onError` log sink). Throwing synchronously from this callback
   * propagates as a Connect `Internal` to the CreateSession caller —
   * the row is already INSERTed at that point so the caller will see a
   * row from a subsequent ListSessions even if the spawn never fired.
   *
   * Tests that don't need the spawn wire-up simply omit this field;
   * the handler keeps the pre-#359 row-only behavior.
   */
  readonly attachPtyHost?: (row: SessionRow, principal: AuthPrincipal) => void;
}

/**
 * Build the Connect `ServiceImpl<typeof SessionService>['createSession']`
 * handler. Reads `PRINCIPAL_KEY` from the HandlerContext (the
 * `peerCredAuthInterceptor` deposited it before the handler runs),
 * decodes the proto request into the manager's row-shape input, calls
 * `manager.create(input, principal)`, and renders the response via the
 * shared `sessionRowToProto` mapper.
 *
 * Mirrors the posture of the read / destroy handlers: a missing
 * principal is a daemon wiring bug surfaced as `Internal` rather than
 * `Unauthenticated` (the auth interceptor would have rejected the call
 * before this handler ran if the caller were unauthenticated).
 *
 * Errors raised by `manager.create()` propagate unchanged — v0.3
 * SessionManager.create has no documented failure mode beyond the SQLite
 * INSERT itself (PRIMARY KEY collision on the freshly-generated 26-char
 * ULID is statistically zero; a real SQLite error is `Code.Internal`).
 */
export function makeCreateSessionHandler(
  deps: CreateSessionDeps,
): ServiceImpl<typeof SessionService>['createSession'] {
  return async function createSession(
    req: CreateSessionRequest,
    handlerContext: HandlerContext,
  ) {
    const principal: AuthPrincipal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'CreateSession handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const input = decodeCreateRequest(req);
    const row = deps.manager.create(input, principal);

    // Task #359: kick off the per-session pty-host child + lifecycle
    // watcher AFTER the row is INSERTed (so the child has a row to
    // markEnded against on exit) and BEFORE we render the response (so
    // a parallel PtyService.Attach stream from the same client finds
    // the per-session emitter already registered by the time it
    // dispatches). The callback is fire-and-forget — see CreateSessionDeps
    // jsdoc. Omitted in test fixtures that exercise only the row CRUD
    // path; production `index.ts` wires it via
    // `makeProductionAttachPtyHost`.
    if (deps.attachPtyHost !== undefined) {
      deps.attachPtyHost(row, principal);
    }

    return create(CreateSessionResponseSchema, {
      // Echo request meta unchanged — same convention as Hello,
      // GetCrashLog, ListSessions, GetSession, DestroySession. Clients
      // correlate on request_id round-trip per spec ch04 §2.
      meta: req.meta,
      session: sessionRowToProto(row, principal),
    });
  };
}
