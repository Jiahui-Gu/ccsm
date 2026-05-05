/**
 * Wave-2-C SSE endpoints — `text/event-stream` push channels for the
 * electron renderer.
 *
 * Topics:
 *   - GET /api/events/notify    — `Decision` per qualifying OSC waiting
 *                                 transition (after the 7-rule decider).
 *                                 Frame: `data: {sid,toast,flash}\n\n`.
 *
 * Wire protocol:
 *   - `Content-Type: text/event-stream`
 *   - `Cache-Control: no-cache, no-transform`
 *   - `Connection: keep-alive`
 *   - 15s server-side keepalive comment (`: ping`) so intermediaries don't
 *     idle-close the socket. The native http server doesn't impose a request
 *     timeout by default, but defensive `req.socket.setKeepAlive(true)`
 *     covers OSes with default loopback idle reaping.
 *
 * Lifecycle:
 *   - On `req.close` / `res.close` we unsubscribe + drop the keepalive timer.
 *   - On daemon shutdown the hub.dispose() in startup/system.ts clears
 *     listeners; the in-flight stream sees no more frames and the next
 *     keepalive write will EPIPE → triggers req.close.
 */

import type { Router, Handler } from "../router";
import { notifyHub } from "../notify/hub";
import { badgeStore } from "../notify/badgeStore";

const KEEPALIVE_MS = 15_000;

function writeSseHead(res: import("node:http").ServerResponse): void {
  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no"); // belt-and-suspenders for proxies
  // Flush headers immediately so the client's EventSource onopen fires
  // even before the first event arrives.
  res.flushHeaders?.();
}

function writeFrame(
  res: import("node:http").ServerResponse,
  data: unknown,
): void {
  try {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  } catch {
    /* socket gone — req.close handler will run */
  }
}

const notifyEvents: Handler = (req, _body, res) => {
  writeSseHead(res);
  req.socket.setKeepAlive(true);

  const unsub = notifyHub.onDecision((d) => {
    writeFrame(res, d);
  });

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, KEEPALIVE_MS);
  ping.unref();

  const cleanup = (): void => {
    clearInterval(ping);
    unsub();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  return { status: 0, streamed: true };
};

const badgeEvents: Handler = (req, _body, res) => {
  writeSseHead(res);
  req.socket.setKeepAlive(true);

  // Send initial state so a freshly-attached client doesn't need a polled
  // bootstrap call.
  writeFrame(res, { total: badgeStore.getTotal() });

  const unsub = badgeStore.onChange((total) => {
    writeFrame(res, { total });
  });

  const ping = setInterval(() => {
    try {
      res.write(`: ping\n\n`);
    } catch {
      /* ignore */
    }
  }, KEEPALIVE_MS);
  ping.unref();

  const cleanup = (): void => {
    clearInterval(ping);
    unsub();
    try {
      res.end();
    } catch {
      /* ignore */
    }
  };
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);

  return { status: 0, streamed: true };
};

const register = (router: Router): void => {
  router.addRoute("GET", "/api/events/notify", notifyEvents);
  // SSE variant of the badge state for clients that prefer push over poll.
  // Tray still long-polls /api/badge/state (registered in system.ts) — both
  // are wired so consumers can pick whichever fits their lifecycle.
  router.addRoute("GET", "/api/events/badge", badgeEvents);
};

export default register;
