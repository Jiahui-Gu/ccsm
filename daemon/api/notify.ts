/**
 * Wave-2-C notify producer entry — `POST /api/notify/feedOsc`.
 *
 * Body shape: `{ args: [sid: string, title: string, ts?: number] }`.
 *
 * Routes the raw OSC title through the in-process notify hub (decider +
 * 7-rule + dedupe). Decisions are fanned out to SSE subscribers on
 * `/api/events/notify`; this RPC returns synchronously with whatever the
 * decider produced (so callers can also act locally if they want, e.g.
 * the interim electron-side OSC sniffer flushing through).
 *
 * After W2-B mv's the PTY into the daemon, the in-daemon sniffer can call
 * `notifyHub.feedOsc()` directly without going through HTTP. This RPC is
 * the bridge surface for the wave-1 → W2-B gap when the sniffer still
 * lives in electron/ptyHost.
 */

import type { Router, Handler } from "../router";
import { notifyHub } from "../notify/hub";

interface ArgsBody {
  args?: unknown[];
}

function isArgsBody(b: unknown): b is ArgsBody {
  return typeof b === "object" && b !== null && Array.isArray((b as ArgsBody).args);
}

const feedOsc: Handler = (_req, body) => {
  if (
    !isArgsBody(body) ||
    typeof body.args![0] !== "string" ||
    typeof body.args![1] !== "string"
  ) {
    return { status: 400, error: "bad_args" };
  }
  const sid = body.args![0] as string;
  const title = body.args![1] as string;
  const tsRaw = body.args![2];
  const ts = typeof tsRaw === "number" && Number.isFinite(tsRaw) ? tsRaw : undefined;
  const decision = notifyHub.feedOsc(sid, title, ts);
  return { status: 200, body: { decision } };
};

const register = (router: Router): void => {
  router.addRoute("POST", "/api/notify/feedOsc", feedOsc);
};

export default register;
