import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

// R-48 (Task #160): sid envelope codec + tunnel control-frame types are SoT
// in @ccsm/shared. The daemon-side codec (packages/daemon/src/tunnel.mts)
// imports the same module; envelope.test.ts proves the two ends agree
// byte-for-byte (R-41 envelope regression history).
import {
  WS_SUBPROTOCOL_PREFIX,
  decodeSidEnvelope as decodeSidEnvelopeShared,
  encodeSidEnvelope,
  type BrowserIdentity,
  type HelloFrame,
  type HttpReqFrame,
  type HttpResFrame,
} from '@ccsm/shared';

// R-47 (Task #162): structured logger replaces the [r28] / [do] console.log
// forensics tags. Per-request `Logger.child(reqId)` stamps the request_id
// from `X-CCSM-Request-Id` so DO records pivot with the worker entry +
// daemon http_req records on the same request.
import { Logger } from './logger';

/**
 * DO-side decode adapter: the WebSocket Hibernation API delivers binary
 * frames as `ArrayBuffer`; the shared codec works on `Uint8Array`. Wrap
 * once at the call boundary so the rest of the file stays unchanged.
 */
function decodeSidEnvelope(
  buf: ArrayBuffer,
): { sid: string; payload: Uint8Array } | null {
  return decodeSidEnvelopeShared(new Uint8Array(buf));
}

/**
 * HTTP-over-tunnel timeout. Cloudflare Worker subrequest cap is 30s; we
 * reject in-flight HTTP requests after that with 504 so the browser sees a
 * deterministic upstream timeout instead of a Worker eviction.
 */
const HTTP_OVER_TUNNEL_TIMEOUT_MS = 30_000;

/** WebSocket Hibernation API tags (passed to state.acceptWebSocket). */
const TAG_DAEMON = 'daemon';
const TAG_BROWSER = 'browser';

/**
 * Per-browser tag prefix (Task #105, R-41). The browser ws is registered
 * with `[TAG_BROWSER, TAG_BROWSER_SID + sid]` so the DO can recover the
 * correct ws per sid post-hibernation via `state.getWebSockets(tag)`. We
 * keep TAG_BROWSER on the same ws too so legacy "list every browser"
 * lookups still work.
 */
const TAG_BROWSER_SID_PREFIX = 'browser-sid:';

// R-48 (Task #160): `ENVELOPE_MAX_SID_LEN`, `encodeSidEnvelope`,
// `HelloFrame`, `BrowserIdentity`, `HttpReqFrame`, `HttpResFrame` all live
// in @ccsm/shared. Imports at the top of this file. The daemon-side
// equivalent (packages/daemon/src/tunnel.mts) imports the same module so
// wire format cannot drift.

interface PendingHttp {
  resolve: (res: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Per-socket state persisted across hibernation via ws.serializeAttachment.
 * Browser sockets carry the bearer token extracted from Sec-WebSocket-Protocol
 * so the daemon-side hello frame can be re-emitted if needed; daemon sockets
 * carry no per-conn state today (helloSeen etc. live on the daemon side).
 */
interface BrowserAttachment {
  role: 'browser';
  token: string;
  /** Task #105 (R-41): sid this browser ws is paired with. Required so the
   * DO can route daemon→browser binary frames by sid (envelope header) and
   * label browser→daemon binary frames before forwarding. */
  sid: string;
  /**
   * Task #133 (S4-T6): cloud-authenticated identity attached to this
   * browser ws. Forwarded to the daemon inside the hello frame; the daemon
   * accepts it (in lieu of token validation) when running with
   * `CCSM_TRUST_TUNNEL=1`. Undefined until the OAuth wire-up (T3/T4) lands.
   */
  identity?: BrowserIdentity;
}

interface DaemonAttachment {
  role: 'daemon';
}

type SocketAttachment = BrowserAttachment | DaemonAttachment;

function buildHelloFrame(
  token: string,
  sid: string,
  lastSeq: number,
  identity?: BrowserIdentity,
): string {
  const frame: HelloFrame = { type: 'hello', token, sid, lastSeq };
  if (identity !== undefined) {
    frame.identity = identity;
  }
  return JSON.stringify(frame);
}

function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let binary = '';
  // Chunk to avoid blowing argument count limits on big payloads.
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(
      null,
      Array.from(bytes.subarray(i, i + CHUNK)),
    );
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Parse a daemon-bound text frame as an http_res control frame. Returns null
 * for raw text (S3-T6 OUTPUT passthrough) so the caller falls through to the
 * existing browser-forward path.
 */
function tryParseControlFrame(text: string): HttpResFrame | null {
  if (text.length === 0 || text.charCodeAt(0) !== 0x7b /* '{' */) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'http_res') return null;
  if (typeof obj.id !== 'string') return null;
  if (typeof obj.status !== 'number') return null;
  if (typeof obj.body_b64 !== 'string') return null;
  if (obj.headers === null || typeof obj.headers !== 'object') return null;
  return parsed as HttpResFrame;
}

/**
 * Extract the daemon bearer token from a browser ws upgrade.
 *
 * Browsers cannot set custom headers on `new WebSocket(url, protocols)`, so
 * the SPA encodes the token as `ccsm.<token>` in the Sec-WebSocket-Protocol
 * request header (RFC 6455 §1.9). The header is a comma-separated list of
 * subprotocol tokens; we take the first `ccsm.*` entry.
 *
 * Returns null when the header is absent / malformed / has no ccsm.* entry.
 * The DO will close the browser socket with 1008 in that case.
 */
function extractBrowserToken(req: Request): { token: string; protocol: string } | null {
  const raw = req.headers.get('sec-websocket-protocol');
  if (raw === null) return null;
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  for (const entry of entries) {
    if (entry.startsWith(WS_SUBPROTOCOL_PREFIX)) {
      const token = entry.slice(WS_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return { token, protocol: entry };
    }
  }
  return null;
}

/**
 * TunnelDO pairs a daemon websocket with a browser websocket and forwards
 * frames between them in both directions.
 *
 * Routes (path is whatever the worker forwards; we match suffix only):
 *   /tunnel/default — daemon dials in (long-lived).
 *   /ws/default     — browser connects; closes 1011 if no daemon paired yet.
 *   /api/*, /token  — HTTP request multiplexed over the daemon ws (Task #787).
 *
 * Hibernation (Task #790, S3-E): the DO uses Cloudflare's WebSocket
 * Hibernation API (`state.acceptWebSocket` + `webSocketMessage` /
 * `webSocketClose` / `webSocketError` class methods) so the runtime can
 * evict the JS instance during idle periods without losing the daemon
 * pairing. On wake, sockets are recovered via `state.getWebSockets(tag)`
 * and per-socket state via `ws.deserializeAttachment()`.
 *
 * In-flight HTTP request promises (`pendingHttp`) are intentionally NOT
 * persisted — hibernation invalidates the resolve closure, so any pending
 * request at hibernate time is effectively dropped (browser retries).
 *
 * S3-T2 (Task #774). Token plumbing S3-T6 (Task #782). HTTP mux S3-C (Task #787).
 * Hibernation S3-E (Task #790).
 */
export class TunnelDO extends DurableObject<Env> {
  private pendingHttp = new Map<string, PendingHttp>();
  /**
   * R-47 (Task #162): module-default logger; per-request work uses
   * `this.logger.child(requestId)` so each line carries the cf-worker-derived
   * request_id (X-CCSM-Request-Id header). Construction is cheap (one object,
   * no env reads) so we do it eagerly in the constructor.
   */
  private readonly logger: Logger;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.logger = new Logger();
  }

  /** Convenience for state.getWebSockets — `this.ctx` is provided by the base class. */
  private get state(): DurableObjectState {
    return this.ctx;
  }

  /** Recover the daemon socket post-hibernation, or undefined if none.
   * Filters by readyState so stale/closing sockets aren't selected. */
  private getDaemonSocket(): WebSocket | undefined {
    const arr = this.state.getWebSockets(TAG_DAEMON);
    for (const ws of arr) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return undefined;
  }

  /** Recover the browser socket post-hibernation, or undefined if none.
   *
   * Task #105 (R-41): wave-2 supports multiple concurrent browser ws (one
   * per sid) attached to the same DO. Pass `sid` to look up the specific
   * browser ws; without it we return any OPEN browser ws (legacy callers
   * that don't yet route by sid). The sid-indexed lookup uses the per-ws
   * tag `browser-sid:<sid>` set at acceptWebSocket time. */
  private getBrowserSocket(sid?: string): WebSocket | undefined {
    if (sid !== undefined) {
      const tagged = this.state.getWebSockets(TAG_BROWSER_SID_PREFIX + sid);
      for (const ws of tagged) {
        if (ws.readyState === WebSocket.OPEN) return ws;
      }
      return undefined;
    }
    const arr = this.state.getWebSockets(TAG_BROWSER);
    for (const ws of arr) {
      if (ws.readyState === WebSocket.OPEN) return ws;
    }
    return undefined;
  }

  /** Return all currently-OPEN browser ws (Task #105 R-41 hibernation diag). */
  private getAllBrowserSockets(): WebSocket[] {
    const arr = this.state.getWebSockets(TAG_BROWSER);
    return arr.filter((ws) => ws.readyState === WebSocket.OPEN);
  }

  override async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const upgrade = req.headers.get('Upgrade');

    // HTTP-over-tunnel (Task #787): /api/* and /token are NOT ws upgrades —
    // they're regular requests muxed over the daemon ws as control frames.
    if (
      upgrade?.toLowerCase() !== 'websocket' &&
      (url.pathname.startsWith('/api/') || url.pathname === '/token')
    ) {
      return this.proxyHttp(req);
    }

    if (upgrade?.toLowerCase() !== 'websocket') {
      return new Response('Expected websocket', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];

    if (url.pathname.endsWith('/tunnel/default')) {
      // Don't proactively close any "stale" daemon ws here. CF's hibernation
      // runtime fires webSocketClose on dead sockets and removes them from
      // state on its own; readyState filtering in getDaemonSocket() handles
      // the transient case. Closing here triggered a reconnect loop in prod
      // because the still-open prior daemon ws (from a fast reconnect) got
      // 1011'd by the next handshake, which the daemon then retried.
      const attachment: DaemonAttachment = { role: 'daemon' };
      this.state.acceptWebSocket(server, [TAG_DAEMON]);
      server.serializeAttachment(attachment);
      // R-17 log #1 (Task #45): daemon ws accepted into hibernation pool.
      console.log('[do] daemon ws accepted');
      // S4-T9 (Task #135): if the daemon dialed with a `ccsm.<jwt>`
      // subprotocol (Task #141 jwt-mode path), RFC 6455 §4.2.2 requires
      // the server to echo back exactly one of the offered subprotocols on
      // the 101 response — otherwise standards-compliant clients (Node's
      // built-in WebSocket, recent `ws@8`, browsers) close the handshake
      // with "Server sent no subprotocol". The browser path already echoes
      // (line below); the daemon path forgot to until cross-user-isolation
      // (T9) tried to dial with a tunnel JWT subprotocol against wrangler
      // dev. legacy / unauth daemons don't send a subprotocol — we echo
      // only when one was offered.
      const daemonProto = extractBrowserToken(req);
      if (daemonProto !== null) {
        return new Response(null, {
          status: 101,
          webSocket: client,
          headers: { 'Sec-WebSocket-Protocol': daemonProto.protocol },
        });
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname.endsWith('/ws/default')) {
      const daemon = this.getDaemonSocket();
      if (daemon === undefined) {
        // No daemon paired — accept-and-close so the browser sees a clean 1011
        // rather than a half-open handshake. We don't hibernate this socket.
        server.accept();
        server.close(1011, 'daemon offline');
        return new Response(null, { status: 101, webSocket: client });
      }
      // Task #782: extract + stash browser token; emit hello to daemon so the
      // daemon can authorize before any forwarded frame.
      const extracted = extractBrowserToken(req);
      if (extracted === null) {
        server.accept();
        server.close(1008, 'missing token subprotocol');
        return new Response(null, { status: 101, webSocket: client });
      }

      // Task #793 (S3-G): the browser ws URL carries the session id + ring
      // replay cursor as query params (`?sid=<s>&lastSeq=<n>`). Both are
      // forwarded to the daemon inside the hello frame so the daemon can
      // route the paired ws into the right per-session PTY. Missing sid →
      // close 1008 (browser bug; falling through with no sid would dump
      // every PTY's bytes into a wrong-tab terminal).
      const sid = url.searchParams.get('sid') ?? '';
      if (sid.length === 0) {
        server.accept();
        server.close(1008, 'missing sid');
        return new Response(null, { status: 101, webSocket: client });
      }
      const lastSeqRaw = url.searchParams.get('lastSeq');
      let lastSeq = 0;
      if (lastSeqRaw !== null) {
        const n = Number(lastSeqRaw);
        if (Number.isFinite(n) && Number.isInteger(n) && n >= 0 && n <= 0xffffffff) {
          lastSeq = n;
        }
        // Bad lastSeq → fall through with 0 (matches daemon "missing == 0").
      }

      // Don't proactively close any prior browser ws — same reasoning as the
      // daemon path above. readyState filtering picks the live one.
      // Task #105 (R-41): tag the browser ws with `browser-sid:<sid>` so
      // post-hibernation lookups can recover the right ws per sid.
      // Task #133 (S4-T6) + Task #136 (S4-T5): in jwt-mode the cf-worker
      // verifies the browser's web JWT and injects the resolved identity
      // via `X-CCSM-Identity-Login` / `X-CCSM-Identity-Id` request headers
      // before forwarding into this DO. In legacy mode (no JWT, S3-era
      // smoke flow) the headers are absent and identity stays undefined —
      // the daemon then falls back to validating the bearer token itself.
      //
      // R-58 (Task #182): `X-CCSM-Identity-Id` carries the uuid user PK
      // (claims.sub since R-51a Task #167), NOT the GitHub numeric id. The
      // wire field on `BrowserIdentity` was renamed `github_id` → `user_id`
      // to match.
      const idLogin = req.headers.get('X-CCSM-Identity-Login');
      const idUserId = req.headers.get('X-CCSM-Identity-Id');
      const identity: BrowserIdentity | undefined =
        idLogin !== null && idUserId !== null
          ? { login: idLogin, user_id: idUserId }
          : undefined;
      const attachment: BrowserAttachment = identity !== undefined
        ? { role: 'browser', token: extracted.token, sid, identity }
        : { role: 'browser', token: extracted.token, sid };
      this.state.acceptWebSocket(server, [TAG_BROWSER, TAG_BROWSER_SID_PREFIX + sid]);
      server.serializeAttachment(attachment);
      // R-17 log #2 (Task #45): browser ws accepted, about to emit hello.
      console.log('[do] browser ws accepted sid=' + sid + ' token=' + extracted.token.slice(0, 6));

      // Emit hello as the first daemon-bound frame after this browser pair.
      try {
        daemon.send(buildHelloFrame(extracted.token, sid, lastSeq, identity));
        // R-17 log #3 (Task #45): hello successfully sent to daemon.
        console.log('[do] hello sent to daemon');
      } catch (err) {
        // R-17 log #3 (Task #45): hello send threw — daemon ws likely just dropped.
        console.log('[do] hello send failed: ' + String(err));
        /* daemon may have just dropped; cleanup happens via webSocketClose */
      }
      // Echo the chosen subprotocol on the 101 response so the browser
      // accepts the handshake (RFC 6455 §4.2.2 step 4).
      return new Response(null, {
        status: 101,
        webSocket: client,
        headers: { 'Sec-WebSocket-Protocol': extracted.protocol },
      });
    }

    return new Response('Not Found', { status: 404 });
  }

  // --- WebSocket Hibernation API event dispatch -------------------------
  //
  // Cloudflare runtime calls these class methods (instead of addEventListener
  // callbacks) so the DO instance can be evicted during idle periods and
  // re-instantiated lazily on next event. Sockets are recovered via
  // state.getWebSockets(tag); per-socket state via ws.deserializeAttachment().

  override webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    if (att === null) {
      // Should not happen — we always serialize on accept. Defensive close.
      try { ws.close(1011, 'no attachment'); } catch { /* ignore */ }
      return;
    }
    if (att.role === 'daemon') {
      this.handleDaemonMessage(message);
    } else {
      this.handleBrowserMessage(message, att.sid);
    }
  }

  override webSocketClose(ws: WebSocket, _code: number, _reason: string, _wasClean: boolean): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    // R-17 log #4 (Task #45): record close code/reason/wasClean for both roles.
    console.log('[do] ws close role=' + att?.role + ' code=' + _code + ' reason=' + _reason + ' wasClean=' + _wasClean);
    if (att === null) return;
    if (att.role === 'daemon') {
      this.handleDaemonClose();
    } else {
      this.handleBrowserClose();
    }
  }

  override webSocketError(ws: WebSocket, _err: unknown): void {
    const att = ws.deserializeAttachment() as SocketAttachment | null;
    // R-17 log #5 (Task #45): record ws-level error for both roles.
    console.error('[do] ws error role=' + att?.role + ' err=' + String(_err));
    if (att === null) return;
    if (att.role === 'daemon') {
      this.handleDaemonError();
    }
    // browser error: nothing to do (mirrors prior behavior — wireBrowser had no error handler).
  }

  private handleDaemonMessage(data: string | ArrayBuffer): void {
    // R-17 log #6 (Task #45): direction + length for every daemon→browser frame.
    const len = typeof data === 'string' ? data.length : data.byteLength;
    console.log('[do] msg dir=daemon->browser len=' + len);
    if (typeof data === 'string') {
      const ctrl = tryParseControlFrame(data);
      if (ctrl !== null) {
        this.completeHttpRes(ctrl);
        return;
      }
      // Hello / other control text frames are passed to the (single, legacy)
      // browser ws if any. With wave-2 routing the daemon doesn't send text
      // frames browser-ward (PTY data is binary + sid-enveloped) — this
      // branch only fires for legacy / debug text frames. Pick first OPEN.
      const browser = this.getBrowserSocket();
      if (browser !== undefined) {
        try { browser.send(data); } catch { /* ignore */ }
      }
      return;
    }
    // Task #105 (R-41): binary frame from daemon → strip sid envelope →
    // route to the browser ws that paired on that sid. Drop with a log if
    // envelope is malformed or the sid is unknown (browser may have just
    // closed; daemon will see ws-close back-pressure on its own).
    const env = decodeSidEnvelope(data);
    if (env === null) {
      console.log('[do] drop daemon->browser binary: malformed sid envelope (len=' + len + ')');
      return;
    }
    const browser = this.getBrowserSocket(env.sid);
    if (browser === undefined) {
      const known = this.getAllBrowserSockets().length;
      console.log('[do] drop daemon->browser binary: no browser for sid=' + env.sid + ' (open browsers=' + known + ')');
      return;
    }
    try {
      // Strip envelope before delivering to the browser — the browser ws
      // protocol is plain encoded frames (@ccsm/shared.encodeFrame output).
      browser.send(env.payload);
    } catch { /* browser may have just dropped */ }
  }

  private handleBrowserMessage(data: string | ArrayBuffer, sid: string): void {
    // R-17 log #6 (Task #45): direction + length for every browser→daemon frame.
    const len = typeof data === 'string' ? data.length : data.byteLength;
    console.log('[do] msg dir=browser->daemon len=' + len + ' sid=' + sid);
    const daemon = this.getDaemonSocket();
    if (daemon === undefined) return;
    if (typeof data === 'string') {
      // Text frames from browser are not used in current protocol; forward
      // raw for forward-compat (no sid header — text frames stay control).
      try { daemon.send(data); } catch { /* daemon may have just dropped */ }
      return;
    }
    // Task #105 (R-41): wrap browser→daemon binary frame in sid envelope so
    // the daemon can route INPUT/RESIZE/PAUSE/RESUME into the right per-sid
    // PTY when multiple browser tabs share one tunnel ws.
    let envelope: Uint8Array;
    try {
      envelope = encodeSidEnvelope(sid, new Uint8Array(data));
    } catch (err) {
      console.log('[do] drop browser->daemon binary: envelope encode failed sid=' + sid + ' err=' + String(err));
      return;
    }
    try { daemon.send(envelope); } catch { /* daemon may have just dropped */ }
  }

  private handleDaemonClose(): void {
    // Task #105 (R-41): close every paired browser ws (wave-2 may have many).
    for (const browser of this.getAllBrowserSockets()) {
      try { browser.close(1006, 'daemon disconnected'); } catch { /* ignore */ }
    }
    this.failAllPendingHttp(502, 'daemon disconnected');
  }

  private handleDaemonError(): void {
    for (const browser of this.getAllBrowserSockets()) {
      try { browser.close(1011, 'daemon error'); } catch { /* ignore */ }
    }
  }

  private handleBrowserClose(): void {
    // Daemon stays alive; nothing to do beyond letting CF drop the ws ref.
  }

  /** Test-only accessor for the currently-paired browser token. */
  getBrowserTokenForTest(): string | null {
    const browser = this.getBrowserSocket();
    if (browser === undefined) return null;
    const att = browser.deserializeAttachment() as SocketAttachment | null;
    if (att === null || att.role !== 'browser') return null;
    return att.token;
  }

  /** Test-only accessor for in-flight HTTP request count. */
  getPendingHttpCountForTest(): number {
    return this.pendingHttp.size;
  }

  /**
   * Serialize a regular HTTP request into an http_req control frame, send it
   * on the daemon ws, and await the matching http_res. 30s timeout → 504.
   * Daemon offline → 503 immediately. Daemon drop while pending → 502.
   */
  private async proxyHttp(req: Request): Promise<Response> {
    // R-47 (Task #162): bind the cf-worker-stamped request_id (set by the
    // Worker entry, see index.ts withRequestId) to a child logger. Missing
    // header (legacy / direct DO test) leaves the field unset; downstream
    // log search just sees no `request_id` on those lines.
    const reqId = req.headers.get('X-CCSM-Request-Id') ?? undefined;
    const log: Logger =
      reqId !== undefined && reqId.length > 0
        ? this.logger.child(reqId)
        : this.logger;
    const url = new URL(req.url);
    const path = url.pathname;
    const daemonAll = this.state.getWebSockets(TAG_DAEMON);
    const daemonStates = daemonAll.map((ws) => ws.readyState).join(',');
    const browserAll = this.state.getWebSockets(TAG_BROWSER);
    log.debug('do.proxy_http.enter', {
      path,
      method: req.method,
      daemon_count: daemonAll.length,
      daemon_states: daemonStates,
      browser_count: browserAll.length,
      pending_http: this.pendingHttp.size,
    });
    const daemon = this.getDaemonSocket();
    if (daemon === undefined) {
      log.warn('do.proxy_http.no_daemon', { path, status: 503 });
      return new Response('daemon offline', { status: 503 });
    }
    const id = crypto.randomUUID();
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const body = await req.arrayBuffer();
    const body_b64 = body.byteLength === 0 ? '' : arrayBufferToBase64(body);
    const frame: HttpReqFrame = {
      type: 'http_req',
      id,
      method: req.method,
      path: url.pathname + url.search,
      headers,
      body_b64,
    };
    // R-46 audit-P0 (Task #158, F-T-2): propagate request_id end-to-end so
    // daemon log records can be correlated with worker + DO records for the
    // same request. Header is set by the Worker entry (deriveRequestId);
    // missing header (legacy / direct DO test) leaves the field unset, and
    // the daemon falls back to '-' placeholder.
    if (reqId !== undefined && reqId.length > 0) {
      frame.request_id = reqId;
    }
    log.debug('do.proxy_http.send_frame', {
      path,
      id,
      body_len: body.byteLength,
    });
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        if (this.pendingHttp.delete(id)) {
          log.warn('do.proxy_http.timeout', { path, id, status: 504 });
          resolve(new Response('upstream timeout', { status: 504 }));
        }
      }, HTTP_OVER_TUNNEL_TIMEOUT_MS);
      this.pendingHttp.set(id, { resolve, timer });
      try {
        daemon.send(JSON.stringify(frame));
      } catch (err) {
        clearTimeout(timer);
        this.pendingHttp.delete(id);
        log.warn('do.proxy_http.send_failed', {
          path,
          id,
          status: 502,
          err: String(err),
        });
        resolve(new Response('upstream send failed', { status: 502 }));
      }
    });
  }

  /** Reject every in-flight HTTP request when the daemon ws drops. */
  private failAllPendingHttp(status: number, body: string): void {
    this.logger.warn('do.pending_http.fail_all', {
      status,
      body,
      count: this.pendingHttp.size,
    });
    for (const [, pending] of this.pendingHttp) {
      clearTimeout(pending.timer);
      pending.resolve(new Response(body, { status }));
    }
    this.pendingHttp.clear();
  }

  /** Resolve a pending HTTP request from a parsed http_res control frame. */
  private completeHttpRes(frame: HttpResFrame): void {
    const pending = this.pendingHttp.get(frame.id);
    if (pending === undefined) {
      this.logger.warn('do.proxy_http.no_pending', {
        id: frame.id,
        status: frame.status,
        decision: 'maybe-timed-out',
      });
      return;
    }
    this.logger.info('do.proxy_http.complete', {
      id: frame.id,
      status: frame.status,
      body_len: frame.body_b64.length,
    });
    this.pendingHttp.delete(frame.id);
    clearTimeout(pending.timer);
    const bytes = frame.body_b64.length === 0
      ? new Uint8Array(0)
      : base64ToUint8Array(frame.body_b64);
    pending.resolve(
      new Response(bytes as unknown as BodyInit, {
        status: frame.status,
        headers: frame.headers,
      }),
    );
  }
}
