// PtyService.Resize handler — daemon-side sink that forwards client
// geometry changes (cols, rows) to the per-session pty-host child.
//
// Spec refs:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch04 §6 (RPC contract: `Resize(session_id, geometry) -> empty`).
//     ch05 §5 (per-RPC enforcement matrix: load by id; assertOwnership;
//             then forward).
//   - docs/superpowers/specs/2026-05-05-v03-test-shells.md §2.2
//     (test shells: forwards (cols,rows) / INVALID_ARGUMENT when ≤0 /
//     NOT_FOUND when sid unknown).
//   - packages/proto/src/ccsm/v1/pty.proto line 14 / 33-36 / 136-141
//     (ResizeRequest{meta, session_id, geometry}; PtyGeometry{cols, rows}
//     int32). Proto3 int32 admits negative values on the wire — daemon
//     MUST validate.
//   - packages/daemon/src/pty-host/types.ts (HostToChildMessage:
//     {kind:'resize', cols, rows}).
//
// SRP layering — three roles kept separate (dev.md §2):
//   - decider: `validateGeometry` — pure (cols > 0 && rows > 0) check.
//              Exported for unit tests so the boundary is grep-able.
//   - producer: the in-process pty-host child handle obtained from
//              `deps.getPtyHost(sessionId)`. The handle's `send` method
//              is the seam to `child_process.fork`'s IPC channel.
//   - sink:    `makeResizeHandler(deps)` — Connect handler factory.
//              Reads PRINCIPAL_KEY, validates geometry, runs the
//              not-found-vs-not-owned distinction (test shell §2.2),
//              forwards the resize message, returns the meta-only ack.
//
// See `pty-sendinput.ts` header for the rationale on the two-seam
// findSession/assertSessionOwned shape (NOT_FOUND vs PERMISSION_DENIED
// codes must remain wire-distinguishable per the test shells).

import { create } from '@bufbuild/protobuf';
import {
  Code,
  ConnectError,
  type HandlerContext,
  type ServiceImpl,
} from '@connectrpc/connect';

import {
  ResizeResponseSchema,
  type PtyService,
  type ResizeRequest,
} from '@ccsm/proto';

import { PRINCIPAL_KEY, type Principal as AuthPrincipal } from '../auth/index.js';

import {
  assertSessionOwned,
  type PtyHostSender,
  type SessionFinder,
} from './pty-sendinput.js';

// ---------------------------------------------------------------------------
// Deps shape
// ---------------------------------------------------------------------------

export interface ResizeDeps {
  readonly findSession: SessionFinder;
  /**
   * Resolve the per-session pty-host child handle. Same semantics as
   * SendInput's `getPtyHost`: undefined => session has no live child =>
   * FailedPrecondition.
   */
  readonly getPtyHost: (sessionId: string) => PtyHostSender | undefined;
}

// ---------------------------------------------------------------------------
// Decider — pure geometry validation
// ---------------------------------------------------------------------------

/**
 * Pure decider — returns null when (cols, rows) are both strictly
 * positive integers, or a human-readable rejection reason otherwise.
 *
 * Why strict positivity (matches test shell §2.2 verbatim "cols/rows
 * ≤ 0"): xterm/PTY behavior at zero or negative dimensions is undefined
 * and platform-dependent. We mirror exactly what the spec says; tighter
 * platform-specific bounds (e.g. xterm refusing < 4×4) are enforced one
 * layer down by the pty-host child.
 *
 * Pure / exported for unit tests so the boundary is grep-able.
 */
export function validateGeometry(
  cols: number,
  rows: number,
): string | null {
  if (!Number.isInteger(cols) || cols <= 0) {
    return `cols must be a positive integer; got ${cols}`;
  }
  if (!Number.isInteger(rows) || rows <= 0) {
    return `rows must be a positive integer; got ${rows}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

/**
 * Build the `PtyService.Resize` unary handler.
 *
 * Flow per spec ch05 §5 / ch04 §6 + test shell §2.2:
 *   1. Read PRINCIPAL_KEY.
 *   2. Validate (cols, rows) > 0. Surface InvalidArgument BEFORE the
 *      session lookup — invalid input is the client's bug regardless of
 *      ownership, and rejecting early avoids a needless DB hit.
 *   3. `findSession(session_id)` — null => Code.NOT_FOUND.
 *   4. `assertSessionOwned(principal, row)` — mismatch =>
 *      Code.PERMISSION_DENIED (ch05 §5).
 *   5. Resolve pty-host child handle. Missing -> FailedPrecondition.
 *   6. `host.send({kind:'resize', cols, rows})`.
 *   7. Return meta-only acknowledgement.
 */
export function makeResizeHandler(
  deps: ResizeDeps,
): ServiceImpl<typeof PtyService>['resize'] {
  return async function resize(
    req: ResizeRequest,
    handlerContext: HandlerContext,
  ) {
    const principal: AuthPrincipal | null = handlerContext.values.get(PRINCIPAL_KEY);
    if (principal === null) {
      throw new ConnectError(
        'PtyService.Resize handler invoked without peerCredAuthInterceptor in chain ' +
          '(PRINCIPAL_KEY=null) — daemon wiring bug',
        Code.Internal,
      );
    }

    const sessionId = req.sessionId;
    if (sessionId.length === 0) {
      throw new ConnectError(
        'ResizeRequest.session_id MUST be non-empty',
        Code.InvalidArgument,
      );
    }

    // Geometry is required on the wire (proto3 message field defaults
    // to a zero-valued PtyGeometry{cols=0, rows=0} if omitted — which
    // the validator rejects, so the absent-vs-zero distinction
    // collapses to the same InvalidArgument).
    const geometry = req.geometry;
    const cols = geometry?.cols ?? 0;
    const rows = geometry?.rows ?? 0;
    const reason = validateGeometry(cols, rows);
    if (reason !== null) {
      throw new ConnectError(reason, Code.InvalidArgument);
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

    host.send({ kind: 'resize', cols, rows });

    return create(ResizeResponseSchema, {
      meta: req.meta,
    });
  };
}
