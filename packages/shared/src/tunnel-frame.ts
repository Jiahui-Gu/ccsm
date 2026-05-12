// Tunnel control-frame types + ws subprotocol constant shared between the
// daemon (packages/daemon/src/tunnel.mts) and the cf-worker TunnelDO
// (packages/cf-worker/src/tunnel-do.ts).
//
// R-48 (Task #160): single source of truth. The daemon and DO previously
// each redeclared HelloFrame / HttpReqFrame / HttpResFrame / BrowserIdentity
// and each held their own `WS_SUBPROTOCOL_PREFIX = 'ccsm.'` constant. Wire
// drift between the two was a silent-corruption class of bug (R-41 envelope
// regression history); putting the type & constant SoT here removes one
// drift surface.
//
// NOTE: only the *type* declarations live here. Each side keeps its own
// runtime parser (`parseHttpReq`, `parseHello`, `tryParseControlFrame`)
// because the two sides need different validation strictness:
//   - daemon validates the FIRST text frame as a hello and accepts http_req
//     mid-stream; rejects anything else 1008.
//   - DO validates daemon-side text frames as http_res; raw text without a
//     JSON `type` is OUTPUT passthrough.
// Sharing the type definitions is the structural anchor; the runtime
// validators stay local because their failure modes are not symmetric.

/**
 * WebSocket subprotocol prefix used by both browser↔DO and daemon↔DO
 * handshakes (RFC 6455 §1.9). Browsers cannot set custom headers on
 * `new WebSocket(url, protocols)` so the per-conn token rides
 * `Sec-WebSocket-Protocol: ccsm.<token>`. The daemon does the same with its
 * cloud-issued tunnel JWT (`ccsm.<jwt>`, S4-T8 / Task #141).
 *
 * Same value also lives at packages/frontend-web/src/hostConfig.ts and
 * packages/core/src/ws/client.ts for the SPA / xterm side; those copies
 * predate this SoT and are left untouched here so this PR's blast radius
 * stays contained to daemon + cf-worker (Task #160). A follow-up can fold
 * them in.
 */
export const WS_SUBPROTOCOL_PREFIX = 'ccsm.';

/**
 * Per-browser identity that the cloud has already authenticated on our
 * behalf (Task #133, S4-T6). Present only when the daemon is running in
 * trust-tunnel mode (env `CCSM_TRUST_TUNNEL=1`); legacy / smoke / dogfood
 * paths still ride the per-browser bearer token in `HelloFrame.token` and
 * leave `identity` undefined.
 *
 * `login` is the GitHub login (handle); `user_id` is the cloud-side user
 * PK (a uuid string, R-51a Task #167 — replaced the pre-R-51 github numeric
 * id with `crypto.randomUUID()` so future providers like Google can link to
 * the same user via verified email). The wire field was called `github_id`
 * pre-R-58 (Task #182); kept the daemon expecting numeric ids while the
 * cf-worker had already moved to uuids, with both sides happening to agree
 * (uuid==uuid) but the field name lying about its contents. R-58 renamed it
 * to `user_id` to match the actual value semantics; identity-bind still
 * works the same (daemon compares against `CCSM_EXPECTED_OWNER_ID` parsed
 * from the tunnel JWT's `sub` claim — also a uuid since R-51a).
 */
export interface BrowserIdentity {
  login: string;
  user_id: string;
}

/**
 * First text frame the DO injects on the tunnel ws ahead of any
 * browser→daemon traffic so the daemon can run the browser-presented token
 * (or trust-tunnel identity) through its existing auth check path.
 *
 * Wire format: JSON text frame
 *   `{"type":"hello","token":"<t>","sid":"<s>","lastSeq":<n>,"identity":{...}}`
 *
 * Field optionality:
 *   - `token` is optional in trust-tunnel mode (Task #133, S4-T6); present
 *     on legacy / dogfood deployments.
 *   - `sid` + `lastSeq` are absent on legacy DO builds without per-session
 *     attach (Task #793 added them); newer DOs always send them.
 *   - `identity` is present only when the cloud verified an OAuth session
 *     and the daemon trusts the cloud (`CCSM_TRUST_TUNNEL=1`).
 *
 * Subsequent frames are raw passthrough. The daemon parses ONLY the first
 * text frame as hello; if it's missing or malformed the daemon closes 1008.
 */
export interface HelloFrame {
  type: 'hello';
  /**
   * Legacy per-browser bearer token (constant-time-checked vs daemon
   * token). Optional when the daemon is in trust-tunnel mode AND the hello
   * carries an `identity` instead.
   */
  token?: string;
  /** Task #793 (S3-G): session id from the browser ws `?sid=` query. */
  sid?: string;
  /** Task #793 (S3-G): replay cursor from the browser ws `?lastSeq=` query. */
  lastSeq?: number;
  /** Task #133 (S4-T6): cloud-authenticated browser identity (trust-tunnel). */
  identity?: BrowserIdentity;
}

/**
 * HTTP-over-tunnel request control frame (Task #787, S3-C). The DO mux'es
 * `/api/*` and `/token` over the daemon ws by serializing the inbound
 * Request as one of these frames; the daemon fetches it against the
 * loopback REST surface and replies with an {@link HttpResFrame} of the
 * same `id`.
 */
export interface HttpReqFrame {
  type: 'http_req';
  id: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body_b64: string;
  /**
   * R-46 audit-P0 (Task #158, F-T-2): worker-derived request_id propagated
   * end-to-end so daemon log records can be correlated with worker + DO
   * records. Optional for wire-format backward compat: a daemon talking to
   * an older cf-worker (no field) falls back to a `"no-req-id"` placeholder
   * in log records, and the DO accepts a frame without `request_id`
   * (legacy Worker callsite).
   */
  request_id?: string;
}

/**
 * HTTP-over-tunnel response control frame (Task #787, S3-C). Daemon-→DO
 * reply for an inbound {@link HttpReqFrame} with matching `id`.
 */
export interface HttpResFrame {
  type: 'http_res';
  id: string;
  status: number;
  headers: Record<string, string>;
  body_b64: string;
}
