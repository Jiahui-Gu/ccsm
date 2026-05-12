// Cloud-tunnel WebSocket client (Task #779, S3-T3; T6 token flow Task #782).
//
// Daemon-side outbound WS to the Cloudflare Worker tunnel endpoint. T3 only
// implements the transport: dial, auto-reconnect with exponential backoff +
// jitter, send frames, deliver inbound frames via onFrame callback. Wiring
// (caller reads CCSM_TUNNEL_URL, mints token) lands in T4. T6 adds the
// per-browser token handshake: the DO sends a `{type:"hello",token}` JSON
// text frame as the FIRST inbound frame after a browser pairs; the daemon
// runs that token through the SAME constant-time check the loopback
// HTTP/ws auth uses (auth.mts), and on mismatch the daemon closes the
// tunnel ws with 1008 — the DO will surface that to the browser.
//
// Design notes:
//   - ws package is already a daemon dep (used by ws.mts server) — no new dep.
//   - Backoff sequence is hand-coded (1s / 2s / 4s / 8s / 16s / 30s ...) with
//     ±20% jitter, capped at 30s. p-retry / exponential-backoff are
//     overkill for ~10 lines of setTimeout.
//   - State machine: idle -> connecting -> connected -> reconnecting ->
//     connecting -> ... ; stop() forces 'stopped' (terminal).
//   - send() while not connected drops the frame (logs once). Caller must
//     gate sends on getState() === 'connected' if they care.
//   - Hello state: tracked per-connection (`helloSeen` reset on every dial).
//     Until hello arrives, raw passthrough is gated: binary frames and
//     non-JSON text before hello → close 1008. JSON `{type:"http_req"}`
//     control frames (Task #787) are accepted before hello — they're
//     injected by the DO regardless of browser pairing and carry no browser
//     token by design (Task #789, S3-D).
//   - Multi-sid keep-both (Task #105, R-41): a single SPA reuses one tunnel ws
//     across multiple browser tabs / sessions. Each browser hello carries its
//     own sid; the daemon keeps a Map<sid, attachHandle> and adds a NEW
//     attach on each previously-unseen sid (no tear-down of the prior ones).
//     Same-sid hello is idempotent (token re-checked).
//
//     Wave-1 design (R-27) was tear-down-on-resid: only one active sid at a
//     time. Wave-2 needs concurrent fan-out for multiple tabs sharing one
//     daemon, so that assumption was lifted in R-41. The daemon-bound
//     binary frames carry a sid envelope (see envelope helpers below) so
//     INPUT/RESIZE/PAUSE/RESUME from each tab routes into the correct PTY
//     and OUTPUT from each PTY routes back over the single tunnel ws with
//     a sid header that the DO uses to pick the right browser ws.
//
// timingSafeEqual constant-time comparison is reused from auth.mts (NOT
// reimplemented) to honor the §1 5-tier "use existing in-repo" rule.

import { timingSafeEqual } from 'node:crypto';

import WebSocket, { type RawData } from 'ws';

// R-48 (Task #160): sid envelope codec + tunnel control-frame types are SoT
// in @ccsm/shared. Both daemon and cf-worker DO import the same module so
// wire-format drift is impossible (R-41 envelope regression history).
import {
  decodeSidEnvelope as decodeSidEnvelopeShared,
  encodeSidEnvelope as encodeSidEnvelopeShared,
  type BrowserIdentity,
  type HelloFrame,
  type HttpReqFrame,
  type HttpResFrame,
} from '@ccsm/shared';

// R-47 (Task #162): structured daemon logger. The legacy hello / http_req
// narrative log lines (formerly `console.error('[ccsm] tunnel: ...')` and
// `[r28]` / `[r38-tunnel-tx]` forensics) now route through this logger so
// operators can pivot on `event` / `request_id` the same way they pivot on
// the cf-worker logger lines.
import { Logger, rootLogger } from './logger.mjs';

export type { BrowserIdentity };

export type TunnelState =
  | 'idle'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'stopped';

export interface TunnelClientOptions {
  url: string;
  /**
   * Daemon's expected bearer token. Compared against the token presented in
   * the per-browser hello frame via constant-time equality. Mismatch → ws
   * closed 1008 and the bad frame is NOT forwarded onward (Task #782).
   */
  token: string;
  /** Invoked once per inbound frame from the cloud (binary or text). */
  onFrame: (data: Buffer | string) => void;
  /**
   * Loopback HTTP port the daemon is listening on. Used by the HTTP-over-
   * tunnel path (Task #787, S3-C): incoming `http_req` control frames are
   * fetched against `http://127.0.0.1:<port><path>` and the response is
   * serialized back as an `http_res` control frame on the same ws. Pass 0
   * to disable HTTP mux (tests / configs that only exercise raw ws).
   */
  daemonLoopbackPort?: number;
  /**
   * DI seam for tests. Real code uses the default which constructs a real
   * `ws.WebSocket`. Tests inject a fake socket that implements WsLike.
   */
  wsFactory?: WsFactory;
  /**
   * Optional WebSocket subprotocols to negotiate at handshake (RFC 6455 §1.9).
   *
   * S4-T8 (Task #141): when the daemon is running with a cloud-issued tunnel
   * JWT (env `CCSM_TUNNEL_JWT`, set by the Tauri shell after the user
   * completes device-flow login), we encode the JWT as `ccsm.<jwt>` here.
   * The Cloudflare Worker / TunnelDO will (in future) validate this against
   * the JWT signing key the same way it already validates browser-side
   * `ccsm.<token>` subprotocol values for `/ws/default`. Legacy / unauth
   * daemons leave this undefined and dial without subprotocols.
   */
  subprotocols?: string[];
  /**
   * DI seam for tests. Defaults to `globalThis.fetch` (Node 22). Tests
   * inject a stub so we can drive http_req → http_res without binding a
   * real loopback server.
   */
  fetchImpl?: typeof fetch;
  /**
   * Task #793 (S3-G): invoked when a paired browser ws sends its hello
   * frame containing a session id. The caller (daemon main / ws.mts) wires
   * the supplied `send` channel into the runtime registry's per-session PTY
   * fan-out so OUTPUT frames flow browser-ward and INPUT/RESIZE frames flow
   * PTY-ward. Receives the parsed sid + replay cursor.
   *
   * If absent, hello frames are still token-checked and forwarded raw via
   * onFrame (legacy passthrough behaviour).
   */
  onBrowserAttach?: (info: BrowserAttachInfo) => BrowserAttachHandle | null;
}

/**
 * Information passed to `onBrowserAttach` so the daemon main can resolve the
 * sid → runtime + start fan-out.
 *
 * `send` is a thin wrapper around the underlying ws.send so the caller
 * doesn't have to know whether the bytes are travelling over a real loopback
 * ws or a tunnel (Task #793, S3-G). It is only valid for the duration of
 * the current connection — once `webSocketClose` fires, the handle's
 * `onClose` is invoked so the caller can drop the runtime subscription.
 */
export interface BrowserAttachInfo {
  sid: string;
  lastSeq: number;
  /** Send a binary frame back to the browser via the tunnel. */
  send: (data: Uint8Array | Buffer) => void;
  /**
   * Cloud-authenticated browser identity (Task #133, S4-T6). Present only
   * when the daemon is in trust-tunnel mode AND the hello carried an
   * `identity` block. Legacy token-only pairings leave this `undefined`.
   */
  identity?: BrowserIdentity;
}

/**
 * Caller-returned hooks the tunnel uses to feed browser-bound frames into
 * the daemon's per-session router (Task #793, S3-G).
 */
export interface BrowserAttachHandle {
  /** Daemon-bound binary frame from the browser (INPUT / RESIZE / PAUSE / RESUME). */
  onFrame: (data: Buffer) => void;
  /** Tunnel ws closed — caller must drop subscription, kill if last subscriber. */
  onClose: () => void;
}

/** Minimal subset of `ws.WebSocket` that TunnelClient relies on. */
export interface WsLike {
  readyState: number;
  on(event: 'open', cb: () => void): void;
  on(event: 'message', cb: (data: RawData, isBinary: boolean) => void): void;
  on(event: 'close', cb: (code: number, reason: Buffer) => void): void;
  on(event: 'error', cb: (err: Error) => void): void;
  send(data: Buffer | string | Uint8Array): void;
  close(code?: number, reason?: string): void;
}

export type WsFactory = (url: string, protocols?: string[]) => WsLike;

// Backoff sequence (ms). Each step gets ±20% jitter. Capped at 30s.
const BACKOFF_SEQUENCE_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];
const BACKOFF_JITTER = 0.2;

function defaultWsFactory(url: string, protocols?: string[]): WsLike {
  return new WebSocket(url, protocols) as unknown as WsLike;
}

/**
 * `BrowserIdentity`, `HelloFrame`, `HttpReqFrame`, `HttpResFrame` are
 * imported from `@ccsm/shared` (R-48, Task #160). The daemon-side runtime
 * parsers (`parseIdentity`, `parseHello`, `parseHttpReq`,
 * `tryParseControlFrame`) live below — type SoT is shared, validation is
 * local because daemon and DO have asymmetric strictness.
 */

function parseIdentity(value: unknown): BrowserIdentity | null {
  if (value === null || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;
  if (typeof obj.login !== 'string' || obj.login.length === 0) return null;
  if (typeof obj.user_id !== 'string' || obj.user_id.length === 0) return null;
  return { login: obj.login, user_id: obj.user_id };
}

/**
 * Returns true when the daemon process is configured to trust the cloud
 * tunnel for browser identity (env `CCSM_TRUST_TUNNEL=1`). Read on every
 * call so tests / runtime toggles take effect without re-importing.
 *
 * In trust-tunnel mode the daemon accepts hello frames that carry only
 * `identity` (no `token`) — the Cloudflare Worker has already authenticated
 * the browser via OAuth and signed the JWT. Legacy / dogfood deployments
 * leave the env unset and continue to require the per-browser bearer token.
 */
export function isTrustTunnelEnabled(): boolean {
  return process.env.CCSM_TRUST_TUNNEL === '1';
}

/**
 * Audit F-S-2 (Task #152): in trust-tunnel mode the daemon must reject any
 * hello whose cloud-authenticated identity does not match the user the
 * daemon was started for. Without this check, a misconfigured cloud
 * deploy that signs a JWT for ANY user would let that user hijack this
 * daemon's tunnel.
 *
 * The expected owner is injected by the Tauri shell at spawn time
 * (env `CCSM_EXPECTED_OWNER_ID`, parsed from the local `~/.ccsm/tunnel_jwt`
 * `sub` claim — a uuid since R-51a Task #167; pre-R-51 it was the GitHub
 * numeric id). Empty / unset returns null and the bind check is skipped —
 * legacy deployments without the Tauri shell stay unaffected.
 *
 * Read on every call so tests can toggle via process.env without re-import.
 */
export function getExpectedOwnerId(): string | null {
  const raw = process.env.CCSM_EXPECTED_OWNER_ID;
  if (typeof raw !== 'string' || raw.length === 0) return null;
  return raw;
}

/**
 * HTTP-over-tunnel control frames (Task #787, S3-C) — `HttpReqFrame` and
 * `HttpResFrame` types are imported from `@ccsm/shared` (R-48, Task #160).
 * `parseHttpReq` below is the daemon-side runtime validator.
 */

function parseHttpReq(parsed: Record<string, unknown>): HttpReqFrame | null {
  if (parsed.type !== 'http_req') return null;
  if (typeof parsed.id !== 'string' || parsed.id.length === 0) return null;
  if (typeof parsed.method !== 'string') return null;
  if (typeof parsed.path !== 'string') return null;
  if (typeof parsed.body_b64 !== 'string') return null;
  if (parsed.headers === null || typeof parsed.headers !== 'object') return null;
  // R-46 (Task #158): request_id is optional. Older cf-worker builds will
  // not send it; we tolerate the missing field rather than rejecting the
  // frame (would break wire compat).
  if (
    parsed.request_id !== undefined &&
    typeof parsed.request_id !== 'string'
  ) {
    return null;
  }
  // Trust the DO; we already shape-checked the surface fields.
  return parsed as unknown as HttpReqFrame;
}

function parseHello(text: string): HelloFrame | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (obj.type !== 'hello') return null;
  // Task #133 (S4-T6): token is optional in trust-tunnel mode; presence is
  // re-validated at the call site against env + identity. We just require
  // that IF token is present it be a non-empty string.
  let token: string | undefined;
  if (obj.token !== undefined) {
    if (typeof obj.token !== 'string' || obj.token.length === 0) return null;
    token = obj.token;
  }
  const identity = obj.identity !== undefined ? parseIdentity(obj.identity) : null;
  if (obj.identity !== undefined && identity === null) return null;
  // Reject hello with neither token nor identity outright — there's nothing
  // to authenticate against. (The trust-mode env check still happens at the
  // call site to also reject identity-only hellos when env is unset.)
  if (token === undefined && identity === null) return null;
  const out: HelloFrame = { type: 'hello' };
  if (token !== undefined) out.token = token;
  if (identity !== null) out.identity = identity;
  if (typeof obj.sid === 'string' && obj.sid.length > 0) {
    out.sid = obj.sid;
  }
  if (typeof obj.lastSeq === 'number' && Number.isFinite(obj.lastSeq) && obj.lastSeq >= 0) {
    out.lastSeq = obj.lastSeq;
  }
  return out;
}

// ---- Sid-envelope helpers (Task #105, R-41) ----------------------------
//
// Wave-2 multi-tab routing: the daemon and the DO share ONE tunnel ws but
// must fan out N concurrent browser↔PTY sessions over it. Every binary
// frame on the tunnel carries a small sid header so the receiving side can
// route into the correct per-sid PTY (daemon side) or per-sid browser ws
// (DO side).
//
// Wire format (binary frames only — control text frames like hello /
// http_req / http_res / http_res' are unchanged):
//   byte 0:        sidLen (uint8, MUST be > 0 and <= 64)
//   bytes 1..N:    sid as utf8
//   bytes N+1..:   raw payload (the encoded INPUT / OUTPUT / RESIZE / EXIT
//                  frame produced by @ccsm/shared.encodeFrame)
//
// 64-byte cap on sid is a sanity bound — real sids are short hex/base64url
// strings (~32 chars). A malformed envelope (sidLen=0, sidLen>buf-1, or
// sidLen exceeding the cap) is dropped with a warn log on either side.

// R-48 (Task #160): wire-format helpers live in @ccsm/shared. The two
// wrappers below preserve the legacy daemon-side return type (Node Buffer)
// without touching call sites; the encoded BYTES are produced by the
// shared codec and proven byte-aligned with the cf-worker side via
// shared/test/envelope.test.ts.

function encodeSidEnvelope(
  sid: string,
  payload: Uint8Array | Buffer,
): Buffer {
  const out = encodeSidEnvelopeShared(sid, payload);
  return Buffer.from(out.buffer, out.byteOffset, out.byteLength);
}

function decodeSidEnvelope(
  buf: Buffer,
): { sid: string; payload: Buffer } | null {
  const out = decodeSidEnvelopeShared(buf);
  if (out === null) return null;
  return {
    sid: out.sid,
    payload: Buffer.from(
      out.payload.buffer,
      out.payload.byteOffset,
      out.payload.byteLength,
    ),
  };
}

function constantTimeTokenEquals(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) {
    // Compare against same-length filler to keep timing similar.
    const filler = Buffer.alloc(a.length, 0);
    timingSafeEqual(a, filler);
    return false;
  }
  return timingSafeEqual(a, b);
}

export class TunnelClient {
  private readonly url: string;
  readonly token: string;
  private readonly onFrame: (data: Buffer | string) => void;
  private readonly wsFactory: WsFactory;
  private readonly daemonLoopbackPort: number;
  private readonly fetchImpl: typeof fetch;
  private readonly subprotocols: string[] | undefined;

  private state: TunnelState = 'idle';
  private ws: WsLike | null = null;
  private attempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private helloSeen = false;
  private browserToken: string | null = null;
  // Task #793 (S3-G): per-connection browser session attachment.
  // Task #105 (R-41): wave-2 lifts the single-tab assumption. The tunnel ws
  // is shared across N concurrent browser tabs, so we keep a Map<sid,
  // attachHandle> and add new entries on each previously-unseen hello sid
  // (no tear-down of prior sids — that was the wave-1 R-27 behaviour). On
  // ws close all attach handles are dropped.
  private readonly attachHandles = new Map<string, BrowserAttachHandle>();
  /**
   * Task #133 (S4-T6): per-sid cloud identity map. Populated only in
   * trust-tunnel mode when the hello frame carries an `identity` block.
   * Cleared on dial() / ws close alongside `attachHandles`.
   */
  private readonly identities = new Map<string, BrowserIdentity>();
  private readonly onBrowserAttach: ((info: BrowserAttachInfo) => BrowserAttachHandle | null) | null;

  constructor(opts: TunnelClientOptions) {
    this.url = opts.url;
    this.token = opts.token;
    this.onFrame = opts.onFrame;
    this.wsFactory = opts.wsFactory ?? defaultWsFactory;
    this.daemonLoopbackPort = opts.daemonLoopbackPort ?? 0;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.onBrowserAttach = opts.onBrowserAttach ?? null;
    this.subprotocols =
      opts.subprotocols !== undefined && opts.subprotocols.length > 0
        ? opts.subprotocols
        : undefined;
  }

  getState(): TunnelState {
    return this.state;
  }

  /**
   * Returns the per-browser token observed in the most recent hello frame,
   * or null if no hello has been received on the current connection. Used
   * by the daemon-side router (Task #782) to run frames through the SAME
   * classifyOrigin / token check path the loopback ws path uses — without
   * adding a new auth code path.
   */
  getBrowserToken(): string | null {
    return this.browserToken;
  }

  /**
   * Returns the cloud-authenticated identity for a given paired sid, or null
   * if no hello has been received for that sid or hello carried no identity
   * (legacy / token-only pairing). Task #133 (S4-T6).
   */
  getBrowserIdentity(sid: string): BrowserIdentity | null {
    return this.identities.get(sid) ?? null;
  }

  start(): void {
    if (this.stopped) return;
    if (this.state !== 'idle') return;
    this.dial();
  }

  send(data: Buffer | string): void {
    if (this.state !== 'connected' || this.ws === null) {
      // Drop. Caller can gate on getState() if they care.
      console.warn('[ccsm/tunnel] drop send: state=' + this.state);
      return;
    }
    try {
      this.ws.send(data);
    } catch (err) {
      console.warn('[ccsm/tunnel] send error:', (err as Error).message);
    }
  }

  stop(): void {
    this.stopped = true;
    this.state = 'stopped';
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws !== null) {
      try {
        this.ws.close(1000, 'stop');
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  // ---- internals --------------------------------------------------------

  private dial(): void {
    if (this.stopped) return;
    this.state = 'connecting';
    this.helloSeen = false;
    this.browserToken = null;
    this.attachHandles.clear();
    this.identities.clear();
    let socket: WsLike;
    try {
      socket = this.wsFactory(this.url, this.subprotocols);
    } catch (err) {
      console.warn('[ccsm/tunnel] factory threw:', (err as Error).message);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;

    // R-17 log #9 (Task #45): per-connection inbound frame counter. Reset on
    // every dial() so the close log reports frames-since-open for THIS link.
    let frameCount = 0;

    socket.on('open', () => {
      if (this.stopped) {
        try { socket.close(1000, 'stopped'); } catch { /* ignore */ }
        return;
      }
      this.state = 'connected';
      this.attempts = 0;
    });

    socket.on('message', (raw, isBinary) => {
      // R-17 log #9 (Task #45): tally every inbound frame for the close log.
      frameCount += 1;
      // Hello-gate (Task #782): a browser-paired daemon expects the FIRST
      // text frame to be `{type:"hello",token}` so the daemon can authorize
      // browser-bound raw OUTPUT/INPUT passthrough. Binary or non-JSON text
      // before hello → 1008 (frame is NOT forwarded to onFrame).
      //
      // Task #789, S3-D: HTTP-over-tunnel control frames (`http_req`) are
      // injected by the DO regardless of whether a browser is paired (the
      // browser may hit `/api/*` directly without ever opening a /ws/default
      // session). Those frames carry no browser token by design — the DO
      // already gates HTTP entry — so they MUST be accepted before hello.
      // We sniff text frames for `{type:"http_req"}` first; only "neither
      // hello nor http_req" lands on the rejectHello path.
      //
      // Task #81 (R-27): every text frame is sniffed for hello, even after
      // helloSeen, so a paired SPA can re-pair the same tunnel ws to a new
      // sid (New Session in the SPA). parseHello is cheap (single JSON.parse
      // + shape check) and runs before the raw onFrame fall-through.
      if (isBinary) {
        if (!this.helloSeen) {
          this.rejectHello('binary frame before hello');
          return;
        }
        // RawData covers Buffer | ArrayBuffer | Buffer[]. Normalize to Buffer.
        let buf: Buffer;
        if (Buffer.isBuffer(raw)) {
          buf = raw;
        } else if (Array.isArray(raw)) {
          buf = Buffer.concat(raw);
        } else {
          buf = Buffer.from(raw as ArrayBuffer);
        }
        // Task #105 (R-41): browser→daemon binary frames now carry a sid
        // envelope so a single tunnel ws can route concurrent tabs into the
        // right per-sid PTY. Decode header → look up handle → forward
        // payload. Drop with a warn log if envelope is malformed or the
        // sid was never attached (DO bug or hibernation race).
        if (this.attachHandles.size > 0) {
          const env = decodeSidEnvelope(buf);
          if (env === null) {
            console.warn(
              '[ccsm/tunnel] drop browser->daemon binary: malformed sid envelope (len=' +
                buf.length + ')',
            );
            return;
          }
          const handle = this.attachHandles.get(env.sid);
          if (handle === undefined) {
            console.warn(
              '[ccsm/tunnel] drop browser->daemon binary: no attach for sid=' +
                env.sid + ' (known sids=[' + Array.from(this.attachHandles.keys()).join(',') + '])',
            );
            return;
          }
          handle.onFrame(env.payload);
          return;
        }
        this.onFrame(buf);
        return;
      }

      // Text frame path.
      const text = (Buffer.isBuffer(raw)
        ? raw
        : Array.isArray(raw)
          ? Buffer.concat(raw)
          : Buffer.from(raw as ArrayBuffer)).toString('utf8');

      // 1) http_req control frame — always handled (browser-pairing-independent).
      const ctrl = this.tryParseHttpReq(text);
      if (ctrl !== null) {
        void this.handleHttpReq(ctrl);
        return;
      }

      // 2) hello frame — always sniffed, so SPA re-pair (Task #81) works.
      const hello = parseHello(text);
      if (hello !== null) {
        // Task #133 (S4-T6): two accept paths.
        //   - trust-tunnel mode (CCSM_TRUST_TUNNEL=1): cloud has authed the
        //     browser; hello MUST carry identity. Token (if present) is
        //     informational only — we don't validate it (cloud already did).
        //   - legacy mode: hello MUST carry token, validated constant-time
        //     against the daemon's expected token. identity is ignored if
        //     present (forward-compat with cloud-issued frames during
        //     rollout — server can't trust them when the env opt-in is off).
        if (isTrustTunnelEnabled()) {
          if (hello.identity === undefined) {
            this.rejectHello('trust-tunnel mode but hello missing identity');
            return;
          }
          // Audit F-S-2 (Task #152): identity-bind check. The Tauri shell
          // baked the expected user id into the daemon's env at spawn time
          // (parsed from the persisted tunnel JWT's `sub` claim — a uuid
          // since R-51a Task #167). Reject any hello whose cloud-stamped
          // identity disagrees so a mis-issued JWT cannot hijack this
          // user's daemon. R-58 (Task #182) renamed the wire field
          // `github_id` → `user_id` so the name matches the actual value
          // semantics.
          const expectedOwner = getExpectedOwnerId();
          if (expectedOwner !== null && hello.identity.user_id !== expectedOwner) {
            this.rejectHello(
              'identity-mismatch (expected owner=' +
                expectedOwner +
                ' got=' +
                hello.identity.user_id +
                ')',
            );
            return;
          }
          this.handleHello(hello);
          return;
        }
        if (hello.token === undefined) {
          this.rejectHello('legacy mode but hello missing token');
          return;
        }
        if (!constantTimeTokenEquals(hello.token, this.token)) {
          this.rejectHello('bad token in hello');
          return;
        }
        this.handleHello(hello);
        return;
      }

      // 3) Non-control non-hello text. Gated by helloSeen.
      if (!this.helloSeen) {
        this.rejectHello('malformed hello frame');
        return;
      }
      this.onFrame(text);
    });

    socket.on('error', (err) => {
      console.warn('[ccsm/tunnel] ws error:', err.message);
      // 'close' will fire after 'error' for ws; defer reconnect to 'close'.
    });

    socket.on('close', (code) => {
      this.ws = null;
      this.helloSeen = false;
      this.browserToken = null;
      // Task #793 (S3-G) + Task #105 (R-41): tear down ALL per-sid attaches
      // on tunnel ws drop.
      if (this.attachHandles.size > 0) {
        for (const [sid, handle] of this.attachHandles) {
          try {
            handle.onClose();
          } catch (err) {
            console.warn('[ccsm/tunnel] attach onClose threw sid=' + sid + ':', (err as Error).message);
          }
        }
        this.attachHandles.clear();
      }
      this.identities.clear();
      if (this.stopped) {
        this.state = 'stopped';
        return;
      }
      console.warn(`[ccsm/tunnel] closed code=${code}, will reconnect`);
      // R-17 log #9 (Task #45): frames-since-open helps tell whether the link
      // drained any traffic before closing. Demoted to logger.debug in R-47
      // (Task #162) — gated by CCSM_DEBUG_R39=1 / CCSM_LOG_LEVEL=debug.
      rootLogger.debug('tunnel.close', { code, frame_count: frameCount });
      this.scheduleReconnect();
    });
  }

  /**
   * Handle a token-validated hello frame. Idempotent for a sid we've already
   * attached on this connection; binds a NEW attach handle for any
   * previously-unseen sid (Task #105, R-41 keep-both).
   *
   * Wave-1 (R-27) used to tear down the prior attach on sid change so only
   * one tab could be active at a time. Wave-2 needs concurrent fan-out
   * (multiple tabs over one tunnel ws), so we no longer drop prior sids on
   * a new hello — we just add the new one to the Map.
   */
  private handleHello(hello: HelloFrame): void {
    this.helloSeen = true;
    // Task #133 (S4-T6): in trust-tunnel mode hello.token is undefined; the
    // browserToken passthrough (used by legacy auth introspection) stays
    // null. Subsequent legacy-only code paths must tolerate that.
    this.browserToken = hello.token ?? null;
    const newSid = typeof hello.sid === 'string' && hello.sid.length > 0
      ? hello.sid
      : null;

    if (newSid === null) {
      // Hello without sid (legacy / token-only re-auth). Nothing to attach.
      rootLogger.debug('tunnel.hello', {
        sid: '-',
        last_seq: hello.lastSeq ?? 0,
        outcome: 'no-sid-passthrough',
      });
      return;
    }

    // Already attached for this sid → idempotent. Preserves PTY subscription
    // and replay cursor.
    if (this.attachHandles.has(newSid)) {
      rootLogger.debug('tunnel.hello', {
        sid: newSid,
        last_seq: hello.lastSeq ?? 0,
        outcome: 'idempotent',
        active_sids: this.attachHandles.size,
      });
      return;
    }

    rootLogger.debug('tunnel.hello', {
      sid: newSid,
      last_seq: hello.lastSeq ?? 0,
      outcome: 'attach',
      active_sids: this.attachHandles.size + 1,
    });

    // Task #133 (S4-T6): record identity if present so getBrowserIdentity()
    // and BrowserAttachInfo.identity can surface it.
    if (hello.identity !== undefined) {
      this.identities.set(newSid, hello.identity);
    }

    // Task #793 (S3-G) + Task #105 (R-41): bind a NEW attach handle for the
    // newly-paired sid. send wraps the daemon→browser binary frame in a sid
    // envelope so the DO can pick the right per-sid browser ws.
    if (this.onBrowserAttach !== null) {
      const attachSid = newSid;
      const send = (payload: Uint8Array | Buffer): void => {
        let envelope: Buffer;
        try {
          envelope = encodeSidEnvelope(attachSid, payload);
        } catch (err) {
          console.warn('[ccsm/tunnel] envelope encode failed sid=' + attachSid + ':', (err as Error).message);
          return;
        }
        this.send(envelope);
      };
      try {
        const handle = this.onBrowserAttach({
          sid: attachSid,
          lastSeq: hello.lastSeq ?? 0,
          send,
          ...(hello.identity !== undefined ? { identity: hello.identity } : {}),
        });
        if (handle !== null) {
          this.attachHandles.set(attachSid, handle);
        }
      } catch (err) {
        console.warn('[ccsm/tunnel] onBrowserAttach threw sid=' + attachSid + ':', (err as Error).message);
      }
    }
  }

  private tryParseHttpReq(text: string): HttpReqFrame | null {
    if (text.length === 0 || text.charCodeAt(0) !== 0x7b /* '{' */) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return null;
    }
    if (parsed === null || typeof parsed !== 'object') return null;
    return parseHttpReq(parsed as Record<string, unknown>);
  }

  /**
   * Handle an inbound `http_req` frame: fetch the daemon's loopback HTTP
   * server, serialize the response as `http_res`, send back on the same ws.
   * Errors map to status 502 with text/plain body so the browser sees a
   * deterministic upstream error instead of a hung request.
   */
  private async handleHttpReq(frame: HttpReqFrame): Promise<void> {
    // R-46 (Task #158, F-T-2): request_id propagated from cf-worker via the
    // http_req frame. R-47 (Task #162) routes the daemon-side log lines
    // through the structured logger; the per-request `Logger.child(reqId)`
    // stamps the request_id onto every record so worker + DO + daemon lines
    // pivot together. Older worker builds may omit `request_id` — the
    // log surfaces an explicit '-' so missing-id rows still parse cleanly.
    const reqId = frame.request_id ?? '-';
    const log: Logger = rootLogger.child(reqId);
    if (this.daemonLoopbackPort === 0) {
      log.info('daemon.http_req', {
        id: frame.id,
        method: frame.method,
        path: frame.path,
        status: 503,
        decision: 'no-loopback-port',
      });
      this.send(JSON.stringify({
        type: 'http_res',
        id: frame.id,
        status: 503,
        headers: { 'content-type': 'text/plain' },
        body_b64: Buffer.from('http-over-tunnel disabled (no loopback port)').toString('base64'),
      } satisfies HttpResFrame));
      return;
    }
    const url = `http://127.0.0.1:${this.daemonLoopbackPort}${frame.path}`;
    const body = frame.body_b64.length > 0
      ? Buffer.from(frame.body_b64, 'base64')
      : undefined;
    // Strip hop-by-hop headers + the inbound Host so loopback fetch picks the
    // right one. `content-length` will be recomputed by undici.
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(frame.headers)) {
      const lk = k.toLowerCase();
      if (lk === 'host' || lk === 'connection' || lk === 'content-length') continue;
      headers[k] = v;
    }
    log.debug('daemon.http_req.enter', {
      id: frame.id,
      method: frame.method,
      path: frame.path,
      loopback_port: this.daemonLoopbackPort,
      body_len: body?.length ?? 0,
    });
    const startedAt = Date.now();
    let response: globalThis.Response;
    try {
      const init: RequestInit = {
        method: frame.method,
        headers,
        redirect: 'manual',
      };
      if (body !== undefined) {
        init.body = body;
      }
      response = await this.fetchImpl(url, init);
    } catch (err) {
      log.warn('daemon.http_req.fetch_failed', {
        id: frame.id,
        method: frame.method,
        path: frame.path,
        err: (err as Error).message,
        dur_ms: Date.now() - startedAt,
      });
      this.send(JSON.stringify({
        type: 'http_res',
        id: frame.id,
        status: 502,
        headers: { 'content-type': 'text/plain' },
        body_b64: Buffer.from(`upstream error: ${(err as Error).message}`).toString('base64'),
      } satisfies HttpResFrame));
      return;
    }
    const resHeaders: Record<string, string> = {};
    response.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });
    const resBody = Buffer.from(await response.arrayBuffer());
    log.info('daemon.http_req.exit', {
      id: frame.id,
      method: frame.method,
      path: frame.path,
      status: response.status,
      body_len: resBody.length,
      dur_ms: Date.now() - startedAt,
    });
    this.send(JSON.stringify({
      type: 'http_res',
      id: frame.id,
      status: response.status,
      headers: resHeaders,
      body_b64: resBody.toString('base64'),
    } satisfies HttpResFrame));
  }

  private rejectHello(reason: string): void {
    console.warn(`[ccsm/tunnel] hello rejected: ${reason}`);
    if (this.ws !== null) {
      try {
        this.ws.close(1008, reason);
      } catch {
        /* ignore */
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.state = 'reconnecting';
    const delay = this.computeBackoffMs(this.attempts);
    this.attempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.stopped) return;
      this.dial();
    }, delay);
  }

  /** Exposed for tests. Pure function of attempt index. */
  computeBackoffMs(attempt: number): number {
    const idx = Math.min(attempt, BACKOFF_SEQUENCE_MS.length - 1);
    const base = BACKOFF_SEQUENCE_MS[idx] ?? 30_000;
    // ±20% jitter
    const jitter = 1 + (Math.random() * 2 - 1) * BACKOFF_JITTER;
    return Math.min(30_000, Math.round(base * jitter));
  }
}
