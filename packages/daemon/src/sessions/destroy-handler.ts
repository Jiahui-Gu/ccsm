// packages/daemon/src/sessions/destroy-handler.ts
//
// Wave-3 Task #338 — production SessionService.DestroySession Connect handler
// (audit #228 sub-task 7).
//
// Audit reference: docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md
// (sub-task #7). Pre-#338 SessionService.DestroySession was the T2.2 empty
// stub on the wire (`router.ts:STUB_SERVICES`), returning Connect
// `Code.Unimplemented` despite `SessionManager.destroy()` (T3.2 / #38)
// being fully implemented and unit-tested. This file is the thin adapter
// from the proto request shape onto `SessionManager.destroy()` and back to
// the proto `DestroySessionResponse` (which carries only `meta` per the
// session.proto contract — Destroy returns acknowledgement, not the
// destroyed Session). Mirrors the read-side pattern in
// `sessions/read-handlers.ts:makeGetSessionHandler` (Wave 3 §6.9 sub-task
// 5 / Task #336), the WatchSessions stream handler in
// `sessions/watch-sessions.ts` (T3.3 / PR #939) and the symmetric
// CreateSession handler in `sessions/create-handler.ts` (Wave 3 §6.9
// sub-task 6 / Task #339).
//
// Spec refs:
//   - packages/proto/src/ccsm/v1/session.proto (DestroySessionRequest =
//     `{ meta, session_id }`; DestroySessionResponse = `{ meta }` only —
//     the destroyed Session is delivered via the WatchSessions stream's
//     `destroyed` event, not in the unary response).
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §3 (DestroySession unary RPC: principal-scoped, returns
//     acknowledgement immediately so the caller can dismiss the row from
//     its UI before the bus event arrives).
//     ch05 §5 (load by id; `assertOwnership`; flip `should_be_running=0`,
//     transition state to EXITED). The "no such id" and "not yours" cases
//     both collapse to `Code.PermissionDenied + ErrorDetail{code:
//     "session.not_owned"}` inside `SessionManager.loadRow` to prevent
//     cross-principal id enumeration — same security boundary the
//     GetSession handler relies on.
//
// SRP layering — three roles kept separate (dev.md §2):
//   * decider:  there is none worth naming. The wire request carries only
//               `session_id`; no normalization is needed before the
//               manager call (mirrors GetSession in `read-handlers.ts`,
//               which also does no decoding beyond pulling the id off the
//               request).
//   * producer: `SessionManager.destroy(id, caller)` — already implemented
//               in T3.2 / #38; this handler does NOT ship a new producer.
//               The manager is the single source of truth for the row
//               state transition + event-bus publish, shared with the
//               pty-host's `markEnded` lifecycle path.
//   * sink:     `makeDestroySessionHandler(deps)` — Connect handler that
//               reads the principal from `HandlerContext`, calls
//               `manager.destroy()`, and renders the meta-only
//               acknowledgement. The destroyed row's proto shape is
//               available at `sessionRowToProto(row, principal)` if a
//               future v0.4 wire change wants to echo it; v0.3 deliberately
//               does not (the WatchSessions stream is the source of truth
//               for the post-destroy row, per ch04 §3 — keeping Destroy
//               unary lean lets the client's optimistic-removal path
//               render before the round-trip completes).
//
// Layer 1 — alternatives checked:
//   - Re-implement the row -> proto translation locally and echo the
//     destroyed Session in the response: rejected — the proto contract
//     (`DestroySessionResponse { meta }`) only carries `meta`. Adding a
//     `session` field would be a breaking proto change outside this PR's
//     scope, and the post-destroy row is already deliverable via the
//     WatchSessions stream's `destroyed` event payload (a single source
//     of truth across unary + streaming).
//   - Add a `manager.destroyWithProto(req, principal)` convenience:
//     rejected for the same reason as `create-handler.ts` — the manager
//     is intentionally proto-agnostic (see `sessions/types.ts` header
//     comment) so unit tests do not need a proto fixture and the v0.3 /
//     v0.4 wire shapes can evolve independently of the in-process row
//     shape. The adapter (this file) is the right seam.
//   - Inline the SQL UPDATE in the handler: rejected — duplicates
//     `SessionManager.destroy()` and bypasses `assertRowOwned` (the
//     security boundary). Sharing the manager keeps the
//     "not_owned == not_found" enumeration-prevention rule in one place.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  DestroySessionResponseSchema,
  type DestroySessionRequest,
  type SessionService,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';

import type { ISessionManager } from './SessionManager.js';

// ---------------------------------------------------------------------------
// Sink — Connect handler
// ---------------------------------------------------------------------------

export interface DestroySessionDeps {
  readonly manager: ISessionManager;
}

/**
 * Build the Connect `ServiceImpl<typeof SessionService>['destroySession']`
 * handler. Reads `PRINCIPAL_KEY` from the HandlerContext (the
 * `peerCredAuthInterceptor` deposited it before the handler runs), calls
 * `manager.destroy()`, and returns a meta-only acknowledgement.
 *
 * Mirrors the posture of `read-handlers.ts:makeGetSessionHandler`,
 * `watch-sessions.ts:makeWatchSessionsHandler`, and
 * `create-handler.ts:makeCreateSessionHandler`: a missing principal is a
 * daemon wiring bug surfaced as `Internal` rather than `Unauthenticated`
 * (the auth interceptor would have rejected the call before this handler
 * ran if the caller were unauthenticated).
 *
 * Errors raised by `manager.destroy()` propagate unchanged. Spec ch05 §5:
 *   - "no such id"          -> Code.PermissionDenied + session.not_owned
 *   - "id owned by a peer"  -> Code.PermissionDenied + session.not_owned
 *   (collapsed inside `SessionManager.loadRow` -> `assertRowOwned` to
 *    prevent cross-principal id enumeration; same security boundary the
 *    GetSession handler relies on).
 *
 * The destroyed row IS delivered to the caller via the WatchSessions
 * stream's `destroyed` event (the SessionManager publishes on the same
 * in-memory bus the WatchSessions handler subscribes to — single
 * SessionManager instance shared across all SessionService overlays per
 * `index.ts` startup wiring). v0.3 does NOT echo it in the unary response
 * (the proto `DestroySessionResponse` only carries `meta`).
 */
export function makeDestroySessionHandler(
  deps: DestroySessionDeps,
): ServiceImpl<typeof SessionService>['destroySession'] {
  return async function destroySession(
    req: DestroySessionRequest,
    handlerContext: HandlerContext,
  ) {
    const principal: AuthPrincipal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'DestroySession handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    // The manager performs load + assertOwnership + UPDATE + bus publish.
    // We deliberately discard the returned `SessionRow` — the proto
    // response carries only `meta` (see file header comment + spec
    // ch04 §3). Subscribers to the WatchSessions stream observe the
    // post-destroy row via the bus event.
    deps.manager.destroy(req.sessionId, principal);

    return create(DestroySessionResponseSchema, {
      // Echo request meta unchanged — same convention as the other unary
      // handlers (Hello, GetCrashLog, ListSessions, GetSession,
      // CreateSession). Clients correlate on request_id round-trip per
      // spec ch04 §2.
      meta: req.meta,
    });
  };
}
