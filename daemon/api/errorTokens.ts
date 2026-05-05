/**
 * Closed error-token enum for daemon RPC `{ ok: false, error: <token> }`
 * responses — spec 2026-05-06 v0.3 e2e cutover §3.5.6 / §3.6.
 *
 * The `error` field of every `{ ok: false }` daemon RPC response MUST be
 * exactly one of `ErrorToken`. Adding a new token is a breaking change
 * that requires a spec edit.
 *
 * `RPC_ERROR_SUBSET` enforces the per-RPC subset rule (§3.5.6 second
 * table): each RPC may emit ONLY tokens from its allowed column. Reviewers
 * grep against this table; `assertEmittable` is the runtime guard.
 *
 * Notes:
 *   - `pty:checkClaudeAvailable` never emits `ok:false`; failures are
 *     encoded as `{ available: false, reason }` (kept here as an empty
 *     allowlist so misuse trips the assertion immediately).
 *   - `daemon_unavailable` is a renderer-side bridge token; the daemon
 *     itself MUST NEVER emit it. Excluded from every RPC subset.
 *
 * SRP: this is a pure decider table — no I/O, no side effects. Importable
 * from any handler / test without dragging the http server in.
 */

export const ERROR_TOKENS = [
  "no_such_sid",
  "pty_dead",
  "bad_request",
  "spawn_failed",
  "daemon_unavailable",
  "internal",
] as const;

export type ErrorToken = (typeof ERROR_TOKENS)[number];

/** Type guard — true iff `v` is one of the closed enum values. */
export function isErrorToken(v: unknown): v is ErrorToken {
  return typeof v === "string" && (ERROR_TOKENS as readonly string[]).includes(v);
}

/**
 * Per-RPC allowed token subsets. Keys are the daemon RPC identifiers
 * (matching the `pty:*` topic in §3.5.6). The renderer-bridge entry
 * is documented but lives outside the daemon — present here so test
 * tables can reference one canonical map.
 */
export type RpcId =
  | "pty:spawn"
  | "pty:input"
  | "pty:resize"
  | "pty:attach"
  | "pty:checkClaudeAvailable";

export const RPC_ERROR_SUBSET: Readonly<Record<RpcId, readonly ErrorToken[]>> = {
  "pty:spawn":               ["bad_request", "spawn_failed", "internal"],
  "pty:input":               ["no_such_sid", "pty_dead", "bad_request", "internal"],
  "pty:resize":              ["no_such_sid", "pty_dead", "bad_request", "internal"],
  "pty:attach":              ["no_such_sid", "internal"],
  // checkClaudeAvailable never returns ok:false — the empty allowlist is
  // intentional. Any attempt to emit a token from this RPC trips the
  // assertion, redirecting authors to `{ available:false, reason }`.
  "pty:checkClaudeAvailable": [],
};

/**
 * Runtime enforcement: throws if `token` is not in the allowed subset
 * for `rpc`. Use at the boundary where a handler builds its `{ ok:false,
 * error }` response — this turns a contract drift into a test-time
 * failure rather than a silent wire-shape regression.
 */
export function assertEmittable(rpc: RpcId, token: ErrorToken): void {
  const allowed = RPC_ERROR_SUBSET[rpc];
  if (!allowed.includes(token)) {
    throw new Error(
      `errorTokens: RPC ${rpc} may not emit '${token}'. Allowed: [${allowed.join(", ") || "(none — use ok:true response shape)"}]`,
    );
  }
}

/**
 * Build a typed `{ ok:false, error }` response after validating the token
 * against the per-RPC subset. Preferred over hand-rolled object literals
 * because the call site is forced to pick `rpc`, which makes grep audits
 * trivial.
 */
export function failResponse(
  rpc: RpcId,
  token: ErrorToken,
): { ok: false; error: ErrorToken } {
  assertEmittable(rpc, token);
  return { ok: false, error: token };
}
