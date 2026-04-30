// Control-plane carve-out — exempt from envelope HMAC + hello-required gate.
// Allowlist only; mutation requires spec round.
//
// Single source of truth for the §3.4.1.h supervisor / control-socket RPC set.
// Consumers (per spec):
//   - control-socket dispatcher (T16) routes ONLY these names.
//   - migrationGateInterceptor (§3.4.1.f) uses this allowlist to decide
//     which RPCs survive a migration window.
//   - frag-8 §8.5 migration scope references the same constant to keep the
//     three sites from drifting on what counts as control-plane.
//
// Spec citation: docs/superpowers/specs/v0.3-fragments/frag-3.4.1-envelope-hardening.md §3.4.1.h
// (table row "control-socket": `/healthz`, `/stats`, `daemon.hello`,
//  `daemon.shutdown`, `daemon.shutdownForUpgrade`).

export const SUPERVISOR_RPCS = [
  '/healthz',
  '/stats',
  'daemon.hello',
  'daemon.shutdown',
  'daemon.shutdownForUpgrade',
] as const;

export type SupervisorRpc = (typeof SUPERVISOR_RPCS)[number];

// Pre-built Set for O(1) predicate lookup; the tuple itself stays the
// canonical ordered export (frozen by `as const`).
const SUPERVISOR_RPC_SET: ReadonlySet<string> = new Set(SUPERVISOR_RPCS);

/**
 * Returns true iff `name` is one of the canonical control-plane RPC names.
 *
 * Pure predicate — no normalisation, no prefix matching, no wildcards.
 * Anything outside the literal allowlist is data-plane and MUST go through
 * the full envelope HMAC + hello-required gate.
 */
export function isSupervisorRpc(name: string): boolean {
  return SUPERVISOR_RPC_SET.has(name);
}
