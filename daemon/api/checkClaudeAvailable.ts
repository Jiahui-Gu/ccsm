/**
 * `pty:checkClaudeAvailable` — daemon RPC handler module.
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.5.3 + §3.5.6 (HP-9, PR-5).
 *
 * Wire shape:
 *   POST  body { force?: boolean }
 *   200   { available: true,  path: string }
 *   200   { available: false, reason?: string }
 *
 * Per §3.5.6 this RPC NEVER returns `{ ok: false, error }` — failures
 * are always encoded as `{ available: false, reason: <one-line> }`.
 * The error-token subset for `pty:checkClaudeAvailable` is therefore
 * empty; `assertEmittable` would throw if a future change accidentally
 * tried to emit `{ ok:false, error:'...' }` here.
 *
 * MUST (§3.5.3): never throws. Resolver errors are caught and surfaced
 * as `{ available: false, reason }` so the renderer's TerminalPane
 * "Retry" UI has a stable contract.
 *
 * Anti-stub (§3.5.5): the `available: true` branch MUST be backed by
 * a real `resolveClaude()` lookup (which runs `where claude.cmd` /
 * `which claude`). No hard-coded `{ available: true }` shortcut.
 *
 * SRP: pure decider over the `resolveClaude` sink. No caching of its
 * own — the resolver owns the cache, this module just observes it.
 *
 * Auto-registry note: registrar-free — production
 * `/api/pty/checkClaudeAvailable` is owned by `daemon/api/pty.ts`.
 */

import type { IncomingMessage } from "node:http";

import type { HandlerResult, Router } from "../router";
import { resolveClaude } from "../ptyHost/claudeResolver";

interface AvailableOk {
  available: true;
  path: string;
}

interface AvailableNo {
  available: false;
  reason?: string;
}

export type CheckClaudeAvailableResponse = AvailableOk | AvailableNo;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function checkClaudeAvailableHandler(
  _req: IncomingMessage,
  body: unknown,
): HandlerResult {
  // Body is optional; only `{ force?: boolean }` is read. Anything else
  // is ignored (per the spec wire-shape — extra keys forward-compatible).
  const force = isObj(body) && body.force === true;

  let resolved: string | null;
  try {
    resolved = resolveClaude({ force });
  } catch (err) {
    // Per §3.5.3 MUST never throw. resolver itself returns null on
    // exec error today; this catch is belt-and-braces for future
    // changes that might let an exception escape.
    const reason = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `[ccsmd] ${new Date().toISOString()} warn api: pty:checkClaudeAvailable resolver threw: ${reason}\n`,
    );
    return { status: 200, body: { available: false, reason } satisfies AvailableNo };
  }

  if (resolved) {
    return { status: 200, body: { available: true, path: resolved } satisfies AvailableOk };
  }
  return {
    status: 200,
    body: { available: false, reason: "claude_not_on_path" } satisfies AvailableNo,
  };
}

export function registerCheckClaudeAvailableAt(router: Router, path: string): void {
  router.addRoute("POST", path, checkClaudeAvailableHandler);
}
