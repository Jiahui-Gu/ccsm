/**
 * `pty:input` (SendInput) — daemon RPC handler module.
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.5.1 + §3.5.6 (HP-9, PR-5).
 *
 * Wire shape:
 *   POST  body { sid: string, data: string }
 *   200   { ok: true }
 *   200   { ok: false, error: <ErrorToken> }   (per §3.5.6 subset)
 *   400   { error: 'bad_request: <field>' }   (request-shape failures)
 *
 * R1 baseline-cite (§3.5.1): v0.2 `pty:input` (35b08d15^) silently dropped
 * writes to an unknown sid (200 OK + no-op). v0.3 MUST preserve that
 * silent-drop semantics; promotion to a typed `no_such_sid` is a v0.4
 * candidate gated on user/product approval. We therefore return
 * `{ ok: true }` for unknown sid and reserve `no_such_sid` / `pty_dead`
 * for v0.4 surface promotion (the §3.5.6 subset still permits them so
 * the wire vocabulary is forward-stable).
 *
 * Anti-stub (§3.5.5): when sid IS live, we MUST actually drive the
 * underlying pty.write — never fake `{ ok: true }`. The single call into
 * `inputPtySession` (which routes to `pty.write`) is the real work.
 *
 * SRP: this module is a thin sink (writes one byte stream to one pty).
 * No state, no caching, no batching — those belong to deciders/sinks
 * elsewhere in the lifecycle layer.
 *
 * Auto-registry note (`daemon/api/index.ts`): we deliberately do NOT
 * expose a default-export registrar. The production `/api/pty/input`
 * route is owned by `daemon/api/pty.ts`; this module is a single-
 * responsibility unit (handler + register-into-an-explicit-router) used
 * by tests and by future refactors that pull pty.ts apart. Keeping it
 * registrar-free avoids the "Route already registered" throw that would
 * crash the daemon at boot if the auto-registry double-mounted us on
 * the same path as pty.ts.
 */

import type { IncomingMessage } from "node:http";

import type { HandlerResult, Router } from "../router";
import { inputPtySession, getPtySession } from "../ptyHost";
import { failResponse, type ErrorToken } from "./errorTokens";

const RPC_ID = "pty:input" as const;

interface SendInputBody {
  sid: string;
  data: string;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBody(body: unknown): SendInputBody | { badField: string } {
  if (!isObj(body)) return { badField: "body" };
  const sid = body.sid;
  const data = body.data;
  if (typeof sid !== "string" || sid.length === 0) return { badField: "sid" };
  if (typeof data !== "string") return { badField: "data" };
  return { sid, data };
}

/**
 * Pure handler — called by the router pipeline (raw req + parsed body).
 * Returns one of:
 *   - 400 `{ error: 'bad_request: <field>' }` for shape failures
 *   - 200 `{ ok: true }` happy path (incl. v0.2 silent-drop on unknown sid)
 *   - 200 `{ ok: false, error: 'internal' }` only when pty.write throws
 *     synchronously through `inputPtySession` (the lifecycle layer
 *     swallows these today, kept here as belt-and-braces for the
 *     §3.5.6 subset).
 */
export function sendInputHandler(
  _req: IncomingMessage,
  body: unknown,
): HandlerResult {
  const parsed = parseBody(body);
  if ("badField" in parsed) {
    return { status: 400, error: `bad_request: ${parsed.badField}` };
  }
  // R1 baseline-cite: v0.2 silent-drop preserved. We still PROBE the
  // session map so a future PR that flips this to a typed error has a
  // single grep-able call site (`getPtySession(sid) === null`).
  const live = getPtySession(parsed.sid) !== null;
  try {
    inputPtySession(parsed.sid, parsed.data);
  } catch (err) {
    return {
      status: 200,
      body: failInternal("inputPtySession threw", err),
    };
  }
  // Live AND threw → handled above. Live AND no throw → ok.
  // Not live → silent-drop ok (v0.2 preservation).
  void live;
  return { status: 200, body: { ok: true } };
}

function failInternal(
  context: string,
  err: unknown,
): { ok: false; error: ErrorToken } {
  // Emit through `failResponse` so the per-RPC subset assertion runs;
  // this catches typos that would otherwise drift the wire shape.
  process.stderr.write(
    `[ccsmd] ${new Date().toISOString()} error api: ${RPC_ID} ${context}: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  return failResponse(RPC_ID, "internal");
}

/**
 * Optional helper — registers the handler at a caller-chosen path on a
 * caller-supplied router. NOT used by `daemon/api/index.ts`
 * auto-registry (intentional — see file header). Tests and future
 * refactors call this directly.
 */
export function registerSendInputAt(router: Router, path: string): void {
  router.addRoute("POST", path, sendInputHandler);
}
