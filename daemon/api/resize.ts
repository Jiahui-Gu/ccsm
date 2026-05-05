/**
 * `pty:resize` (Resize) — daemon RPC handler module.
 *
 * Spec: 2026-05-06 v0.3 e2e-cutover §3.5.2 + §3.5.6 (HP-9, PR-5).
 *
 * Wire shape:
 *   POST  body { sid: string, cols: number, rows: number }
 *   200   { ok: true }
 *   200   { ok: false, error: <ErrorToken> }
 *   400   { error: 'bad_request: <field>' }
 *
 * R1 baseline-cite (§3.5.2): v0.2 `pty:resize` (35b08d15^) clamped
 * invalid cols/rows (<2) by SILENTLY skipping the resize and returning
 * 200 OK; an unknown sid is also silent-drop. v0.3 MUST preserve both
 * envelopes — promotion to `400 bad_request` for sub-minimum geometry
 * is a v0.4 change requiring product approval.
 *
 * Schema-level rejections (non-finite numbers, non-integer, missing
 * fields) are 400 `bad_request` because they were never valid wire
 * shapes; v0.2 also rejected these via the IPC dispatcher's typeguard
 * before reaching the lifecycle layer.
 *
 * Anti-stub (§3.5.5): when the resize IS in-bounds and sid IS live, we
 * MUST drive the underlying `pty.resize`. The `resizePtySession` call
 * is the real work — no `{ ok: true }` shortcut.
 *
 * SRP: thin sink over `resizePtySession`. No state, no debounce, no
 * geometry storage — those concerns live in the lifecycle layer.
 *
 * Auto-registry note: see sendInput.ts header — this module is
 * registrar-free on purpose; production `/api/pty/resize` is owned by
 * `daemon/api/pty.ts`. Double-registration would crash the daemon at
 * boot via the router uniqueness assertion.
 */

import type { IncomingMessage } from "node:http";

import type { HandlerResult, Router } from "../router";
import { resizePtySession } from "../ptyHost";
import { failResponse, type ErrorToken } from "./errorTokens";

const RPC_ID = "pty:resize" as const;

interface ResizeBody {
  sid: string;
  cols: number;
  rows: number;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseBody(body: unknown): ResizeBody | { badField: string } {
  if (!isObj(body)) return { badField: "body" };
  const sid = body.sid;
  const cols = body.cols;
  const rows = body.rows;
  if (typeof sid !== "string" || sid.length === 0) return { badField: "sid" };
  if (typeof cols !== "number" || !Number.isFinite(cols) || !Number.isInteger(cols)) {
    return { badField: "cols" };
  }
  if (typeof rows !== "number" || !Number.isFinite(rows) || !Number.isInteger(rows)) {
    return { badField: "rows" };
  }
  return { sid, cols, rows };
}

export function resizeHandler(
  _req: IncomingMessage,
  body: unknown,
): HandlerResult {
  const parsed = parseBody(body);
  if ("badField" in parsed) {
    return { status: 400, error: `bad_request: ${parsed.badField}` };
  }
  // v0.2 envelope: the lifecycle layer (`L.resize`) clamps cols<2 / rows<2
  // by no-oping. We deliberately do NOT pre-reject those values — the
  // baseline accepts them. Negative / zero values pass through and are
  // dropped by the lifecycle layer; the response is still 200 ok.
  try {
    resizePtySession(parsed.sid, parsed.cols, parsed.rows);
  } catch (err) {
    return { status: 200, body: failInternal("resizePtySession threw", err) };
  }
  return { status: 200, body: { ok: true } };
}

function failInternal(
  context: string,
  err: unknown,
): { ok: false; error: ErrorToken } {
  process.stderr.write(
    `[ccsmd] ${new Date().toISOString()} error api: ${RPC_ID} ${context}: ${
      err instanceof Error ? err.message : String(err)
    }\n`,
  );
  return failResponse(RPC_ID, "internal");
}

export function registerResizeAt(router: Router, path: string): void {
  router.addRoute("POST", path, resizeHandler);
}
