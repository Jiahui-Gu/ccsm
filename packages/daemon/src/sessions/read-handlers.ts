// SessionService read-only handlers — ListSessions + GetSession.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-02-final-architecture.md
//     ch04 §3 (per-RPC enforcement matrix)
//     ch05 §5 (ListSessions = principal-scoped SQL filter, no per-row
//             check; GetSession = load + assertOwnership; both return
//             `Code.PermissionDenied + ErrorDetail{code: "session.not_owned"}`
//             on a not-yours / not-found row — see SessionManager.loadRow
//             for the security boundary that collapses NotFound into
//             not_owned to prevent cross-principal id enumeration).
//   - Wave 3 §6.9 sub-task 5 (Task #336) — only the read pair lands in
//     this PR; CreateSession / DestroySession / RenameSession remain
//     `Unimplemented` until their owning tasks land.
//
// SRP discipline (mirrors `watch-sessions.ts`):
//   - producer: `SessionManager.list(caller)` / `SessionManager.get(id, caller)`
//               own the SQL + ownership check (T3.2 / PR #933). The
//               handler does NOT touch the DB directly.
//   - decider:  there is none worth naming for read-only — both RPCs
//               are unconditional happy-path once the principal is
//               resolved (the "is this row mine?" check lives inside
//               the manager's `assertRowOwned`, which is the single
//               source of truth shared with `destroy`).
//   - sink:     `makeListSessionsHandler` / `makeGetSessionHandler` are
//               the Connect handler functions — they read
//               `PRINCIPAL_KEY` from the HandlerContext, call the
//               manager, map rows → proto via the existing
//               `sessionRowToProto`, and echo `RequestMeta`.
//
// Layer 1 — alternatives checked:
//   - Inline the SQL in the handler. Rejected: duplicates
//     `SessionManager.list/get` and bypasses `assertRowOwned` (the
//     security boundary); reviewer would (rightly) reject. Sharing the
//     manager is the explicit task constraint ("share
//     `SessionManager.list()` / `get()`").
//   - Re-implement row → proto. Rejected: `sessionRowToProto` from
//     `watch-sessions.ts` is already the canonical mapper (handles the
//     `exit_code === -1` sentinel + `LocalUser` owner attribution).
//     Reuse keeps a single mapper; a future field addition only edits
//     one place.
//   - Build a generic "registerRpcWithMeta" helper. Rejected: only two
//     handlers in this PR; sugar would obscure the per-RPC shape that
//     reviewers want to read straight through.
//
// Per Connect-ES `ConnectRouter.service` semantics, registering
// SessionService more than once REPLACES the prior registration (path-keyed
// map). The registration overlay (`registerSessionService` in
// `rpc/router.ts`) therefore installs Hello + WatchSessions + ListSessions
// + GetSession in a SINGLE `router.service(SessionService, ...)` call —
// see the doc on that function for the "registering twice replaces"
// caveat. Methods not yet implemented (CreateSession, DestroySession,
// RenameSession, ...) keep responding `Unimplemented` per the
// "absent method → Unimplemented" router rule.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  GetSessionResponseSchema,
  ListSessionsResponseSchema,
  RequestMetaSchema,
  type GetSessionRequest,
  type ListSessionsRequest,
  type SessionService,
} from '@ccsm/proto';

import { PRINCIPAL_KEY } from '../auth/index.js';

import type { ISessionManager } from './SessionManager.js';
import { sessionRowToProto } from './watch-sessions.js';

/**
 * Dependency bundle shared by the two read handlers — they both call
 * the same `SessionManager` instance owned by daemon startup wiring
 * (one process-wide owner of the `sessions` table).
 */
export interface ReadHandlersDeps {
  readonly manager: ISessionManager;
}

/**
 * Echo the caller's `RequestMeta` back on the response. Mirrors
 * `hello.ts` — daemon does not stamp server timestamps in v0.3 (the
 * `request_id` round-trip is the only invariant the client relies on
 * for log correlation). Returns a fresh proto so each response carries
 * its own message instance (Connect-ES message identity equality is
 * not contractual but copying is cheap and avoids accidental aliasing
 * across responses).
 */
function echoMeta(req: {
  readonly meta?: { readonly requestId: string; readonly clientVersion: string; readonly clientSendUnixMs: bigint } | undefined;
}) {
  return create(RequestMetaSchema, {
    requestId: req.meta?.requestId ?? '',
    clientVersion: req.meta?.clientVersion ?? '',
    clientSendUnixMs: req.meta?.clientSendUnixMs ?? 0n,
  });
}

/**
 * Defensive: if `peerCredAuthInterceptor` did NOT run (daemon wiring
 * bug — the interceptor is supposed to deposit `PRINCIPAL_KEY` before
 * any handler executes), surface as `Code.Internal` so operators see a
 * server-side wiring problem rather than the client being told they
 * are unauthenticated. Mirrors the posture in `hello.ts` /
 * `watch-sessions.ts`.
 */
function requirePrincipal(handlerContext: HandlerContext, rpcName: string) {
  const principal = handlerContext.values.get(PRINCIPAL_KEY);
  if (principal === null) {
    throw new ConnectError(
      `${rpcName} handler invoked without peerCredAuthInterceptor in chain ` +
        '(PRINCIPAL_KEY=null) — daemon wiring bug',
      Code.Internal,
    );
  }
  return principal;
}

/**
 * Build the `ServiceImpl<SessionService>['listSessions']` handler.
 *
 * Spec ch05 §5: SQL `WHERE owner_id = principalKey(ctx.principal)`; no
 * per-row ownership check needed because no foreign rows escape the
 * filter (security boundary lives in `SessionManager.list`).
 */
export function makeListSessionsHandler(
  deps: ReadHandlersDeps,
): ServiceImpl<typeof SessionService>['listSessions'] {
  return async (req: ListSessionsRequest, handlerContext: HandlerContext) => {
    const principal = requirePrincipal(handlerContext, 'ListSessions');
    const rows = deps.manager.list(principal);
    return create(ListSessionsResponseSchema, {
      meta: echoMeta(req),
      sessions: rows.map((row) => sessionRowToProto(row, principal)),
    });
  };
}

/**
 * Build the `ServiceImpl<SessionService>['getSession']` handler.
 *
 * Spec ch05 §5: load by id; `assertOwnership`; return. Both the
 * "no such id" and "not yours" cases collapse to
 * `Code.PermissionDenied + ErrorDetail{code: "session.not_owned"}`
 * inside `SessionManager.loadRow` (prevents cross-principal id
 * enumeration). The handler therefore does not need its own
 * existence/ownership branching — manager.get throws the canonical
 * error directly and Connect propagates it as the RPC's terminal
 * status.
 */
export function makeGetSessionHandler(
  deps: ReadHandlersDeps,
): ServiceImpl<typeof SessionService>['getSession'] {
  return async (req: GetSessionRequest, handlerContext: HandlerContext) => {
    const principal = requirePrincipal(handlerContext, 'GetSession');
    const row = deps.manager.get(req.sessionId, principal);
    return create(GetSessionResponseSchema, {
      meta: echoMeta(req),
      session: sessionRowToProto(row, principal),
    });
  };
}
