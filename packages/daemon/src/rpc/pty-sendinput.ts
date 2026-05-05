// PtyService.SendInput handler — daemon-side sink that forwards client
// keystrokes (raw UTF-8 bytes) to the per-session pty-host child.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §6 (RPC contract: `SendInput(session_id, data) -> empty`).
//     ch05 §5 (per-RPC enforcement matrix: load by id; assertOwnership;
//             then forward).
//   - docs/superpowers/specs/2026-05-05-v03-test-shells.md §2.1
//     (test shell names: forwards utf-8 bytes / NOT_FOUND when sid unknown
//     / PERMISSION_DENIED when principal mismatch).
//   - packages/proto/src/ccsm/v1/pty.proto line 13 / 129-134
//     (SendInputRequest{meta, session_id, data}; SendInputResponse{meta}).
//   - packages/daemon/src/pty-host/types.ts (HostToChildMessage:
//     {kind:'send-input', bytes:Uint8Array}).
//
// SRP layering — three roles kept separate (dev.md §2):
//   - decider: trivial — there is no normalization beyond pulling the id
//              and the bytes off the request. Ownership comparison is
//              `row.owner_id !== principalKey(caller)`, factored to the
//              shared `assertSessionOwned` helper below so both this
//              handler and pty-resize.ts get the same comparison + error.
//   - producer: the in-process pty-host child handle obtained from
//              `deps.getPtyHost(sessionId)`. The handle's `send` method is
//              the seam to `child_process.fork`'s IPC channel.
//   - sink:    `makeSendInputHandler(deps)` — Connect handler factory.
//              Reads PRINCIPAL_KEY from HandlerContext, runs the
//              not-found-vs-not-owned distinction (test shells §2.1
//              REQUIRE Code.NOT_FOUND for unknown sid, ch05 §5 REQUIRES
//              Code.PERMISSION_DENIED for owner mismatch — distinct codes,
//              distinct logs), forwards the bytes, returns the meta-only
//              acknowledgement.
//
// Why we DO NOT reuse `SessionManager.get(id, caller)` (which would do
// load+assertOwnership in one call): the manager's `loadRow` collapses
// "no such id" into the same `session.not_owned` PermissionDenied error
// that "id owned by a peer" produces, intentionally — that collapse is
// the cross-principal id-enumeration security boundary for the
// SessionService surface (Get / Destroy). The PtyService test shells in
// docs/superpowers/specs/2026-05-05-v03-test-shells.md §2.1 / §2.2
// explicitly require Code.NOT_FOUND for an unknown sid and
// Code.PERMISSION_DENIED only for a real owner mismatch — the two
// outcomes MUST be distinguishable on the wire. We therefore inject
// two seams: `findSession(id)` (returns null for unknown id, no throw)
// and `assertOwnership(principal, row)` (throws PermissionDenied on
// mismatch). The handler calls them in order so the wire-visible code
// matches the spec shell.
//
// Layer 1 — alternatives checked:
//   - Add a `manager.findOwned(id, caller)` that returns `not-found` |
//     `not-owned` | `SessionRow`: rejected — adds a third row-lookup API
//     to SessionManager just to keep two error codes distinct on a
//     handler this manager will never call directly. Two seams here keep
//     the manager surface small and let the test fakes be inline objects.
//   - Direct module import of `pty-host/host.ts`'s registry: rejected
//     for the same reason `pty-attach.ts` injects `getEmitter` — keeps
//     the handler unit-testable without `child_process.fork` in tests,
//     and matches the deps-injection precedent.

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  SendInputResponseSchema,
  type PtyService,
  type SendInputRequest,
} from '@ccsm/proto';

import {
  PRINCIPAL_KEY,
  principalKey as toPrincipalKey,
  type Principal as AuthPrincipal,
} from '../auth/index.js';
import type { SessionRow } from '../sessions/types.js';
import type { HostToChildMessage } from '../pty-host/types.js';

// ---------------------------------------------------------------------------
// Shared deps shape (consumed by SendInput AND Resize).
// ---------------------------------------------------------------------------

/**
 * Subset of the in-process pty-host child handle this handler needs.
 * Mirrors `PtyHostChildHandle.send` from `pty-host/host.ts` so the
 * production wiring can pass the real handle directly via `getPtyHost`
 * without an adapter. Tests pass an inline fake.
 */
export interface PtyHostSender {
  send(msg: HostToChildMessage): void;
}

/**
 * Lookup seam: return the SessionRow for `id`, or `undefined` when no
 * such row exists. MUST NOT throw — the handler maps `undefined` to
 * `Code.NotFound` per test shells §2.1 / §2.2.
 *
 * Production wiring: `(id) => sessionManager.tryGet(id)` — a thin
 * exported wrapper around the existing private `loadRow` that returns
 * null instead of throwing. Tests pass an inline `Map<id, row>.get`.
 */
export type SessionFinder = (id: string) => SessionRow | undefined;

/**
 * Assertion seam: throw `Code.PermissionDenied` (`session.not_owned`)
 * iff `principalKey(principal) !== row.owner_id`. Pure (no I/O); the
 * comparison rule is identical to `SessionManager.assertRowOwned`
 * (spec ch05 §4 + §5 — see file header for why we don't simply call
 * `manager.get` instead).
 */
export function assertSessionOwned(
  principal: AuthPrincipal,
  row: SessionRow,
): void {
  if (toPrincipalKey(principal) !== row.owner_id) {
    throw new ConnectError(
      'session not owned by caller',
      Code.PermissionDenied,
    );
  }
}

export interface SendInputDeps {
  readonly findSession: SessionFinder;
  /**
   * Resolve the per-session pty-host child handle. Returns `undefined`
   * when no live child exists — handler maps to FailedPrecondition
   * (ownership has already passed; the row exists but the session is
   * not currently RUNNING).
   */
  readonly getPtyHost: (sessionId: string) => PtyHostSender | undefined;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the `PtyService.SendInput` unary handler.
 *
 * Flow per spec ch05 §5 / ch04 §6 + test shells §2.1:
 *   1. Read PRINCIPAL_KEY (peerCredAuthInterceptor deposited it).
 *   2. `findSession(session_id)` — null => Code.NOT_FOUND.
 *   3. `assertSessionOwned(principal, row)` — mismatch =>
 *      Code.PERMISSION_DENIED + ErrorDetail{code: 'session.not_owned'}
 *      (ch05 §5).
 *   4. Resolve the pty-host child handle. Missing -> FailedPrecondition.
 *   5. `host.send({kind:'send-input', bytes})` — verbatim forward;
 *      child writes bytes to PTY master in receive order.
 *   6. Return meta-only acknowledgement.
 */
export function makeSendInputHandler(
  deps: SendInputDeps,
): ServiceImpl<typeof PtyService>['sendInput'] {
  return async function sendInput(
    req: SendInputRequest,
    handlerContext: HandlerContext,
  ) {
    // Defensive: peerCredAuthInterceptor MUST have run.
    const principal: AuthPrincipal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.SendInput handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const sessionId = req.sessionId;
    if (sessionId.length === 0) {
      throw new ConnectError(
        'SendInputRequest.session_id MUST be non-empty',
        Code.InvalidArgument,
      );
    }

    const row = deps.findSession(sessionId);
    if (row === undefined) {
      throw new ConnectError(
        `no such session: ${sessionId}`,
        Code.NotFound,
      );
    }

    // ch05 §5 — assertOwnership.
    assertSessionOwned(principal, row);

    const host = deps.getPtyHost(row.id);
    if (host === undefined) {
      throw new ConnectError(
        `pty-host child for session ${row.id} is not running`,
        Code.FailedPrecondition,
      );
    }

    // Forward verbatim. Node IPC preserves message order on a single
    // channel, so two SendInput RPCs from the same client serialize
    // naturally — the unary RPC ordering is the source-of-truth ordering
    // observed by the PTY.
    host.send({ kind: 'send-input', bytes: req.data });

    return create(SendInputResponseSchema, {
      meta: req.meta,
    });
  };
}
