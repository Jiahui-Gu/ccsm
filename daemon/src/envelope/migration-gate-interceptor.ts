// migrationGate interceptor — short-circuits data-plane RPCs while a
// SQLite migration is in flight, but lets the canonical control-plane
// allowlist through unconditionally.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md
//     §3.4.1.f (interceptor pipeline, position #3 — runs after helloInterceptor
//     and deadlineInterceptor, before metrics).
//   - Same fragment §3.4.1.h (canonical SUPERVISOR_RPCS allowlist; mutation
//     requires a spec round).
//   - frag-8 §8.5 references the same constant for migration scope.
//
// Single Responsibility: pure decider. This module does NOT
//   - read or store the MIGRATION_PENDING flag (owned by frag-8 / supervisor),
//   - perform any I/O (logging, metrics, socket writes happen at call sites),
//   - normalise the rpcName (literal compare, per §3.4.1.h carve-out lock).
//
// The caller is responsible for sourcing `migrationPending` from the supervisor
// state and translating `{ allowed: false }` into the wire-level rejection
// frame (per §3.4.1.f short-circuit semantics).

import { isSupervisorRpc } from './supervisor-rpcs.js';

export interface MigrationGateContext {
  /** Wire-literal RPC method name (e.g. `ccsm.v1/session.subscribe` or `/healthz`). */
  rpcName: string;
  /** True iff the supervisor's SQLite migration is currently in flight. */
  migrationPending: boolean;
}

export type MigrationGateDecision =
  | { allowed: true }
  | {
      allowed: false;
      error: {
        code: 'MIGRATION_PENDING';
        message: string;
      };
    };

/**
 * Decide whether an envelope-bearing RPC may proceed under the current
 * migration state.
 *
 * Decision table (spec §3.4.1.f / §3.4.1.h):
 *   migrationPending=false                    → allowed (fast path)
 *   migrationPending=true  ∧ supervisor RPC   → allowed (control-plane carve-out)
 *   migrationPending=true  ∧ data-plane RPC   → blocked with MIGRATION_PENDING
 *
 * Pure function — no side effects, no flag storage.
 */
export function checkMigrationGate(
  ctx: MigrationGateContext,
): MigrationGateDecision {
  if (!ctx.migrationPending) {
    return { allowed: true };
  }
  if (isSupervisorRpc(ctx.rpcName)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    error: {
      code: 'MIGRATION_PENDING',
      message: `RPC ${ctx.rpcName} rejected: SQLite migration in progress; only SUPERVISOR_RPCS are accepted until migration completes`,
    },
  };
}
