/**
 * Wave-2-C system RPCs — the small set of "renderer-pushes-to-daemon"
 * lifecycle / preference signals that ride the loopback HTTP fabric.
 *
 * All endpoints follow the wave-2-prep `/api/event/<topic>` convention so
 * the preload bridges can fire-and-forget POST without bespoke per-RPC
 * paths. Body shape is uniform: `{ args: unknown[] }` (matches stub
 * bridges in electron/preload/bridges/ccsmSession.ts + ccsmNotify.ts).
 *
 * Topics:
 *   - notify:userInput   (sid)             — sticky-mute the sid (Rule 1)
 *   - session:setActive  (sid | null)      — renderer-active sid signal
 *   - session:setName    (sid, name)       — currently a no-op placeholder;
 *                                            persistence is W2-A's data.ts
 *                                            sessionTitles-write surface
 *   - ccsm:set-language  (locale)          — currently a no-op placeholder;
 *                                            i18n bundle reload is W2-A
 *   - paths:exist        (path)            — sync-ish fs.existsSync probe
 *
 * Returns 200 `{ ok: true }` on success or 200 `{ exists: boolean }` for
 * the paths probe. Bad payload returns 400 `bad_args`.
 */

import { existsSync } from "node:fs";

import type { Router, Handler, HandlerResult } from "../router";
import { notifyHub } from "../notify/hub";
import { badgeStore } from "../notify/badgeStore";

interface ArgsBody {
  args?: unknown[];
}

function isArgsBody(b: unknown): b is ArgsBody {
  return typeof b === "object" && b !== null && Array.isArray((b as ArgsBody).args);
}

function ok(): HandlerResult {
  return { status: 200, body: { ok: true } };
}

const notifyUserInput: Handler = (_req, body) => {
  if (!isArgsBody(body) || typeof body.args![0] !== "string") {
    return { status: 400, error: "bad_args" };
  }
  const sid = body.args![0] as string;
  notifyHub.markUserInput(sid);
  return ok();
};

const sessionSetActive: Handler = (_req, body) => {
  if (!isArgsBody(body)) return { status: 400, error: "bad_args" };
  const raw = body.args![0];
  const sid = typeof raw === "string" ? raw : raw === null ? null : undefined;
  if (sid === undefined) return { status: 400, error: "bad_args" };
  notifyHub.setActiveSid(sid);
  // Active sid changing is also a focus-clear signal for badges (the user
  // is now looking at this sid). Drop its unread count.
  if (sid) badgeStore.forget(sid);
  return ok();
};

const sessionSetName: Handler = (_req, body) => {
  if (
    !isArgsBody(body) ||
    typeof body.args![0] !== "string" ||
    typeof body.args![1] !== "string"
  ) {
    return { status: 400, error: "bad_args" };
  }
  // Wave-2-C placeholder: persistence lives in W2-A's data.ts sessionTitles
  // write path. Once W2-A merges, this handler will delegate. For now we
  // accept the call (so the bridge stub doesn't 404) and return ok.
  return ok();
};

const ccsmSetLanguage: Handler = (_req, body) => {
  if (!isArgsBody(body) || typeof body.args![0] !== "string") {
    return { status: 400, error: "bad_args" };
  }
  // Wave-2-C placeholder: tray locale + electron app menu reload happen in
  // electron/main.ts. Until W2-A wires the i18n bundle in the daemon we
  // treat this as a no-op signal sink so the bridge call doesn't crash.
  return ok();
};

const pathsExist: Handler = (_req, body) => {
  if (!isArgsBody(body) || typeof body.args![0] !== "string") {
    return { status: 400, error: "bad_args" };
  }
  const p = body.args![0] as string;
  let exists = false;
  try {
    exists = existsSync(p);
  } catch {
    exists = false;
  }
  return { status: 200, body: { exists } };
};

const badgeState: Handler = () => {
  return { status: 200, body: { total: badgeStore.getTotal() } };
};

const register = (router: Router): void => {
  router.addRoute("POST", "/api/event/notify/userInput", notifyUserInput);
  router.addRoute("POST", "/api/event/session/setActive", sessionSetActive);
  router.addRoute("POST", "/api/event/session/setName", sessionSetName);
  router.addRoute("POST", "/api/event/ccsm/set-language", ccsmSetLanguage);
  router.addRoute("POST", "/api/event/paths/exist", pathsExist);
  // Tray polls this every ~5s for the unread count overlay.
  router.addRoute("GET", "/api/badge/state", badgeState);
};

export default register;
