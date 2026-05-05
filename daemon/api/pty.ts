/**
 * `pty:*` HTTP + SSE surface — W2-B (Task #581).
 *
 * Replaces the deleted `electron/ptyHost/ipcRegistrar.ts`. The renderer now
 * talks to the daemon over loopback HTTP instead of Electron IPC; this
 * module exposes the ten ptyHost RPCs the renderer needs plus an SSE
 * endpoint for live `pty:data` / `pty:exit` events.
 *
 * RPC surface (POST `application/json`):
 *   POST /api/pty/spawn                  body { sid, cwd }
 *   POST /api/pty/attach                 body { sid, subscriberId }
 *   POST /api/pty/detach                 body { sid, subscriberId }
 *   POST /api/pty/get                    body { sid }
 *   POST /api/pty/list                   body {}
 *   POST /api/pty/input                  body { sid, data }
 *   POST /api/pty/resize                 body { sid, cols, rows }
 *   POST /api/pty/kill                   body { sid }
 *   POST /api/pty/checkClaudeAvailable   body { force? }
 *   POST /api/pty/getBufferSnapshot      body { sid }
 *
 * Stream surface (SSE, `text/event-stream`):
 *   GET /api/events/pty?sid=<sid>
 *     event: pty:data     data: { sid, chunk, seq }
 *     event: pty:exit     data: { sessionId, code, signal }
 *     event: pty:ack      data: { seq }              (reserved — no producer
 *                                                     today; channel kept so
 *                                                     the preload bridge can
 *                                                     subscribe without a
 *                                                     wire-shape change later)
 *
 * Auto-registry: `daemon/api/index.ts` requires `*.js` siblings and invokes
 * the default export as `(router) => void`. This module exports `register`
 * as the default to plug in.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import {
  attachPtySession,
  detachPtySession,
  getBufferSnapshot,
  getPtySession,
  inputPtySession,
  killPtySession,
  listPtySessions,
  onPtyExit,
  registerSubscriber,
  resizePtySession,
  spawnPtySession,
  unregisterSubscriber,
  type PtyAttachedSubscriber,
} from "../ptyHost";
import { resolveClaude } from "../ptyHost/claudeResolver";
import type { Router, HandlerResult } from "../router";

// --- Body validators ---------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bad(field: string): HandlerResult {
  return { status: 400, error: `bad_request: ${field}` };
}

// --- SSE multiplexer ---------------------------------------------------------

interface SseClient {
  id: string;
  sid: string;
  res: ServerResponse;
  closed: boolean;
}

const sseClients = new Map<string, SseClient>();
let nextClientSeq = 0;

function newClientId(sid: string): string {
  nextClientSeq += 1;
  return `sse-${sid}-${nextClientSeq}-${Date.now()}`;
}

function writeSseEvent(client: SseClient, event: string, payload: unknown): void {
  if (client.closed) return;
  try {
    client.res.write(`event: ${event}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  } catch {
    client.closed = true;
  }
}

function closeSseClient(client: SseClient): void {
  if (client.closed) return;
  client.closed = true;
  try { client.res.end(); } catch { /* socket gone */ }
  sseClients.delete(client.id);
  unregisterSubscriber(client.sid, client.id);
}

// Module-level exit fan-out from ptyHost. Subscribed once per daemon
// process — the SSE multiplexer dispatches by sid to the right open
// responses. We deliberately do NOT subscribe to `onPtyChunk` here:
// `dispatchPtyChunk`'s subscriber sink (`entry.attached`) already pushes
// each chunk to the SSE clients we registered; doubling up would deliver
// every event twice. The exit subscription is needed because a subscriber
// whose `attached.send('pty:exit', ...)` already fired might still have
// its SSE response open (the exit-fan-out is best-effort), so we close
// it deterministically here as a belt-and-braces.
let fanoutInstalled = false;
function ensureFanoutInstalled(): void {
  if (fanoutInstalled) return;
  fanoutInstalled = true;
  onPtyExit((sid) => {
    for (const client of [...sseClients.values()]) {
      if (client.sid === sid) {
        // `entry.attached` already pushed pty:exit via subscriber.send
        // (below) before `emitPtyExit` ran, so no need to re-emit here.
        // Just close the response.
        closeSseClient(client);
      }
    }
  });
}

// --- RPC handlers (return JSON HandlerResult) -------------------------------

function spawnHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  const cwd = str(body.cwd);
  if (!sid) return bad("sid");
  if (cwd === null) return bad("cwd");
  const claudePath = resolveClaude();
  if (!claudePath) return { status: 200, body: { ok: false, error: "claude_not_found" } };
  try {
    const info = spawnPtySession(sid, cwd, claudePath);
    return { status: 200, body: { ok: true, ...info } };
  } catch (err) {
    return {
      status: 200,
      body: {
        ok: false,
        error: `spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
}

function attachHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  if (!sid) return bad("sid");
  const result = attachPtySession(sid);
  return { status: 200, body: { ok: true, attach: result } };
}

function detachHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  if (!sid) return bad("sid");
  detachPtySession(sid);
  // If a subscriberId is supplied (preload bridge sends one when it owns
  // the SSE connection), drop it from the per-entry subscriber map too so
  // a renderer-initiated detach immediately stops `pty:data` deliveries
  // even before the SSE socket fully closes.
  const subscriberId = str(body.subscriberId);
  if (subscriberId) unregisterSubscriber(sid, subscriberId);
  return { status: 200, body: { ok: true } };
}

function getHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  if (!sid) return bad("sid");
  return { status: 200, body: { ok: true, info: getPtySession(sid) } };
}

function listHandler(): HandlerResult {
  return { status: 200, body: { ok: true, sessions: listPtySessions() } };
}

function inputHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  const data = str(body.data);
  if (!sid) return bad("sid");
  if (data === null) return bad("data");
  inputPtySession(sid, data);
  return { status: 200, body: { ok: true } };
}

function resizeHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  const cols = num(body.cols);
  const rows = num(body.rows);
  if (!sid) return bad("sid");
  if (cols === null) return bad("cols");
  if (rows === null) return bad("rows");
  resizePtySession(sid, cols, rows);
  return { status: 200, body: { ok: true } };
}

function killHandler(_req: IncomingMessage, body: unknown): HandlerResult {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  if (!sid) return bad("sid");
  const ok = killPtySession(sid);
  return { status: 200, body: { ok: true, killed: ok } };
}

function checkClaudeAvailableHandler(
  _req: IncomingMessage,
  body: unknown,
): HandlerResult {
  const force =
    isObj(body) && body.force === true ? true : false;
  const p = resolveClaude({ force });
  return p
    ? { status: 200, body: { available: true, path: p } }
    : { status: 200, body: { available: false } };
}

async function getBufferSnapshotHandler(
  _req: IncomingMessage,
  body: unknown,
): Promise<HandlerResult> {
  if (!isObj(body)) return bad("body");
  const sid = str(body.sid);
  if (!sid) return bad("sid");
  const snap = await getBufferSnapshot(sid);
  return { status: 200, body: { ok: true, ...snap } };
}

// --- SSE handler (raw response) ---------------------------------------------

function eventsHandler(req: IncomingMessage, res: ServerResponse): void {
  // Parse `?sid=<sid>` from the unmodified URL.
  const url = req.url ?? "";
  const qIdx = url.indexOf("?");
  const query = qIdx >= 0 ? url.slice(qIdx + 1) : "";
  const params = new URLSearchParams(query);
  const sid = params.get("sid");
  if (!sid) {
    res.statusCode = 400;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ error: "bad_request: sid" }));
    return;
  }

  res.statusCode = 200;
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  // SSE recommended initial comment to flush headers + open the stream
  // before the first real event.
  res.write(": ok\n\n");

  const id = newClientId(sid);
  const client: SseClient = { id, sid, res, closed: false };
  sseClients.set(id, client);

  const subscriber: PtyAttachedSubscriber = {
    id,
    isDestroyed: () => client.closed,
    send: (channel, payload) => writeSseEvent(client, channel, payload),
  };
  const wired = registerSubscriber(sid, subscriber);
  if (!wired) {
    // Session not running — push a synthetic exit so the client can
    // close its EventSource cleanly, then end the stream.
    writeSseEvent(client, "pty:exit", { sessionId: sid, code: null, signal: null });
    closeSseClient(client);
    return;
  }

  const cleanup = (): void => closeSseClient(client);
  req.on("close", cleanup);
  req.on("aborted", cleanup);
  res.on("close", cleanup);
  res.on("error", cleanup);
}

// --- Registrar ---------------------------------------------------------------

export default function register(router: Router): void {
  ensureFanoutInstalled();

  router.addRoute("POST", "/api/pty/spawn", spawnHandler);
  router.addRoute("POST", "/api/pty/attach", attachHandler);
  router.addRoute("POST", "/api/pty/detach", detachHandler);
  router.addRoute("POST", "/api/pty/get", getHandler);
  router.addRoute("POST", "/api/pty/list", listHandler);
  router.addRoute("POST", "/api/pty/input", inputHandler);
  router.addRoute("POST", "/api/pty/resize", resizeHandler);
  router.addRoute("POST", "/api/pty/kill", killHandler);
  router.addRoute("POST", "/api/pty/checkClaudeAvailable", checkClaudeAvailableHandler);
  router.addRoute("POST", "/api/pty/getBufferSnapshot", getBufferSnapshotHandler);

  router.addRawRoute("GET", "/api/events/pty", eventsHandler);
}

/** Test seam: drain SSE state so per-test isolation is clean. */
export function __resetForTest(): void {
  for (const c of [...sseClients.values()]) closeSseClient(c);
  sseClients.clear();
}
