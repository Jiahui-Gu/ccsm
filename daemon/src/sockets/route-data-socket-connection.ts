// daemon/src/sockets/route-data-socket-connection.ts — Coexistence router
// for the data-socket: peeks the first bytes of an accepted connection and
// routes to either the Connect-RPC server (HTTP/2 preface) or the v0.3
// envelope dispatcher (everything else).
//
// Spec citations:
//   - docs/superpowers/specs/2026-05-01-v0.4-web-design.md ch02 §6: data
//     socket = HTTP/2 + Connect; control socket stays envelope.
//   - ch09 §2 deliverable 5 (line 2238): "Daemon: @connectrpc/connect-node
//     Http2Server bound on the data socket alongside the existing envelope
//     handler."
//   - T05 file list (ch09 §2 line 2894): `daemon/src/sockets/data-socket.ts`
//     wire-in. T05.1 lands the wire-in helper; data-socket.ts itself stays
//     as pure transport (single responsibility).
//
// Routing:
//   - HTTP/2 client preface = ASCII bytes `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n`
//     (RFC 7540 §3.5). 24 bytes total. If the first 24 bytes match → Connect.
//   - Anything else → envelope (caller-supplied dispatcher).
//
// Single Responsibility (decider):
//   - Decides Connect vs envelope based on a byte prefix; no envelope or
//     HTTP/2 parsing happens here. The Connect path delegates to
//     `connectServer.attachSocket(socket, transportType)`; the envelope path
//     delegates to `onEnvelopeConnection(socket)`.

import type { Duplex } from 'node:stream';

/** RFC 7540 §3.5 client connection preface (24 bytes). */
export const HTTP2_CLIENT_PREFACE = 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
const HTTP2_PREFACE_BYTES = Buffer.from(HTTP2_CLIENT_PREFACE, 'ascii');
export const HTTP2_PREFACE_LENGTH = HTTP2_PREFACE_BYTES.length;

export interface ConnectAttachable {
  attachSocket(socket: Duplex, transportType: 'local-pipe' | 'remote-tcp'): void;
}

export interface RouteDataSocketConnectionOptions {
  readonly socket: Duplex;
  /**
   * Connect-RPC server to route HTTP/2 traffic to. Pass `undefined` to
   * disable HTTP/2 routing entirely (every connection is treated as
   * envelope). T05.1 default for the daemon shell is `undefined` — wiring
   * comes online with the dormant Connect server but no service handlers
   * registered, so HTTP/2-prefixed traffic is technically accepted but no
   * RPC succeeds. The daemon shell may pass `undefined` until T06 to keep
   * 100% v0.3 envelope behaviour.
   */
  readonly connectServer: ConnectAttachable | undefined;
  /** Transport tag stamped on Connect-routed connections. */
  readonly transportType: 'local-pipe' | 'remote-tcp';
  /** Fallback for non-HTTP/2 traffic (the v0.3 envelope dispatcher). */
  readonly onEnvelopeConnection: (socket: Duplex) => void;
}

/**
 * Wait for at least {@link HTTP2_PREFACE_LENGTH} bytes on the socket then
 * inspect the prefix. Use `socket.unshift()` to put the bytes back so the
 * downstream consumer (Connect or envelope) sees the original stream.
 *
 * If the connection ends or errors before enough bytes arrive, the envelope
 * fallback is invoked with whatever bytes did arrive (envelope handles its
 * own protocol error path).
 *
 * Note: this function returns synchronously after wiring listeners; the
 * actual route decision is async (driven by socket data arrival).
 */
export function routeDataSocketConnection(opts: RouteDataSocketConnectionOptions): void {
  const { socket, connectServer, transportType, onEnvelopeConnection } = opts;

  // Fast path: no Connect server wired → straight to envelope.
  if (connectServer === undefined) {
    onEnvelopeConnection(socket);
    return;
  }

  let buf = Buffer.alloc(0);
  let decided = false;

  const decide = (): void => {
    if (decided) return;
    if (buf.length < HTTP2_PREFACE_LENGTH) return;
    decided = true;
    socket.removeListener('data', onData);
    socket.removeListener('end', onEarlyEnd);
    socket.removeListener('error', onEarlyError);
    const prefix = buf.subarray(0, HTTP2_PREFACE_LENGTH);
    const isHttp2 = prefix.equals(HTTP2_PREFACE_BYTES);
    // Put the buffered bytes back on the stream so the consumer sees them.
    socket.unshift(buf);
    if (isHttp2) {
      connectServer.attachSocket(socket, transportType);
    } else {
      onEnvelopeConnection(socket);
    }
  };

  const onData = (chunk: Buffer): void => {
    buf = buf.length === 0 ? Buffer.from(chunk) : Buffer.concat([buf, chunk]);
    decide();
  };
  const onEarlyEnd = (): void => {
    if (decided) return;
    decided = true;
    socket.removeListener('data', onData);
    socket.removeListener('error', onEarlyError);
    // unshift() after 'end' is illegal (ERR_STREAM_UNSHIFT_AFTER_END_EVENT);
    // the buffered prefix is dropped — the envelope dispatcher receives an
    // ended stream which it'll close as a malformed/empty connection.
    onEnvelopeConnection(socket);
  };
  const onEarlyError = (_err: Error): void => {
    if (decided) return;
    decided = true;
    socket.removeListener('data', onData);
    socket.removeListener('end', onEarlyEnd);
    // Same constraint as onEarlyEnd: don't unshift on a destroyed stream.
    onEnvelopeConnection(socket);
  };

  socket.on('data', onData);
  socket.once('end', onEarlyEnd);
  socket.once('error', onEarlyError);
}
