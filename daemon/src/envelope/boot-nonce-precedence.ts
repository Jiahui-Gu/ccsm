// Reserved-key precedence merger for `x-ccsm-boot-nonce` (spec §3.4.1.c +
// frag-3.4.1 r9 lock line 4059):
//
//   `[manager r9 lock: r8 envelope P1 — x-ccsm-boot-nonce added to
//    reserved-keys allowlist with explicit precedence over body-level
//    bootNonce]`
//
// Security rationale: the daemon mints `bootNonce` (ULID) at supervisor boot
// (spec §3.4.1.g hello reply, frag-6-7 §6.5 healthz). A client must never be
// able to impersonate that value — if a client sends its own
// `x-ccsm-boot-nonce` header on, e.g., a `subscribePty` resubscribe, the
// daemon-set value MUST take precedence so the daemon's view of "did we
// restart between the two subscriptions?" cannot be spoofed.
//
// Single Responsibility: pure header-merge. No socket, no boot-nonce
// generation, no comparison logic — those live in the adapter / lifecycle
// owner. This file only enforces the precedence rule.

/** Reserved header key. Lowercase per spec §3.4.1.c case-insensitive rule. */
export const BOOT_NONCE_HEADER = 'x-ccsm-boot-nonce' as const;

/**
 * Merge two header maps, with daemon-set headers winning on the reserved
 * `x-ccsm-boot-nonce` key. All other keys follow last-writer-wins semantics
 * with `daemonHeaders` overriding `clientHeaders` (consistent with the
 * security posture: the daemon is the trust anchor for any reserved key it
 * chooses to set on a given frame).
 *
 * Pure: never mutates either input. Returns a fresh object.
 *
 * Behavior matrix for `x-ccsm-boot-nonce`:
 *   - daemon set, client set    → daemon value wins (security: anti-spoof)
 *   - daemon set, client absent → daemon value
 *   - daemon absent, client set → client value (daemon hasn't asserted)
 *   - both absent               → key omitted from output
 */
export function applyBootNoncePrecedence(
  daemonHeaders: Readonly<Record<string, string>> | null | undefined,
  clientHeaders: Readonly<Record<string, string>> | null | undefined,
): Record<string, string> {
  const out: Record<string, string> = {};

  // Step 1: copy client headers as the base (lowest precedence).
  if (clientHeaders) {
    for (const [k, v] of Object.entries(clientHeaders)) {
      out[k] = v;
    }
  }

  // Step 2: overlay daemon headers (general last-writer-wins).
  if (daemonHeaders) {
    for (const [k, v] of Object.entries(daemonHeaders)) {
      out[k] = v;
    }
  }

  // Step 3: enforce the reserved-key precedence rule explicitly. If the
  // daemon set the boot nonce, it wins over any client value regardless of
  // iteration order; if not, leave the client value (or omission) intact.
  // Step 2 already produces this outcome, but the explicit assertion guards
  // against future refactors that change merge order.
  const daemonNonce = daemonHeaders?.[BOOT_NONCE_HEADER];
  if (daemonNonce !== undefined) {
    out[BOOT_NONCE_HEADER] = daemonNonce;
  }

  return out;
}
