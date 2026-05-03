// T6.2 — Renderer ↔ daemon transport bridge.
//
// Spec ref: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md`
// chapter 08 §4.2 ("Renderer transport bridge — ships unconditionally in
// v0.3"). Locked decisions captured here so a future reader does not have
// to re-derive them from the spec:
//
//   1. The bridge is hosted in the Electron main process. The renderer
//      cannot speak UDS / named-pipe (Chromium fetch is loopback-TCP only),
//      so a process-local h2c hop is the ONLY way the renderer can reach
//      whatever Listener A transport the daemon picked. Shipping the
//      bridge unconditionally on every OS keeps the renderer transport
//      logic per-OS-uniform (chapter 08 §4.2 reason 1).
//   2. Renderer ↔ bridge: `http2.createServer` on `127.0.0.1` with port 0
//      (OS-assigned ephemeral). NEVER bind `0.0.0.0` — that exposes the
//      bridge to the LAN and the DNS-rebinding hole at chapter 03 §3.1
//      becomes exploitable.
//   3. Every request MUST carry `:authority` (HTTP/2 pseudo-header — moral
//      equivalent of HTTP/1.1's `Host:`) equal to `127.0.0.1:<our-port>`.
//      Anything else → `421 Misdirected Request` per RFC 9113 §8.1.1 and
//      RFC 9110 §15.5.20. This closes the structural part of the renderer
//      DNS-rebinding hole (R2 P0-08-1 / R2 P0-03-1) at the bridge layer.
//      A `Host:` HTTP/1.1 header is folded into `:authority` by Node's
//      http2 layer, so the same check covers both.
//   4. Bridge ↔ daemon: the bridge speaks the daemon's chosen Listener A
//      transport (descriptor `transport` field — closed enum from chapter
//      03 §1a). For UDS / named-pipe the bridge supplies a
//      `createConnection` that opens the named socket; for h2c-loopback
//      it dials the descriptor's host:port. The bridge is the ONLY caller
//      across the OS-level socket; the renderer never touches it.
//   5. The bridge is NOT an IPC re-introduction. It speaks Connect framing
//      (the same `application/connect+proto`-style content the renderer
//      would have sent direct), it does not parse / mutate the protobuf
//      payload, and `lint:no-ipc` (ship-gate (a)) still passes mechanically.
//   6. Streaming: the bridge proxies http2 streams as opaque byte pipes.
//      Headers + DATA + trailers + RST_STREAM all forward both directions.
//      We do NOT terminate Connect on the bridge.
//   7. Slow-consumer / backpressure: rely on the underlying http2 stream's
//      flow control. We do not add an extra buffer; piping in both
//      directions through `stream.pipe(...)` propagates pause / resume.
//   8. Lifecycle: the bridge owns ONE long-lived `http2.connect` session
//      to the daemon (re-created on disconnect). The server owns N
//      ephemeral inbound streams from the renderer; each maps 1:1 to an
//      outbound stream over the daemon session.
//
// Out of scope (deferred to other tasks per the dispatch plan):
//   - Bearer-token belt-and-suspenders: deferred to v0.4 per chapter 08
//     §4.2 reason on `Host:` allowlist. v0.3 ships the structural Host
//     check ONLY.
//   - Reading the descriptor from disk + boot wiring: T6.1 / T6.6 own
//     that path. This module accepts the daemon endpoint as constructor
//     input so unit tests can plug in a stub daemon directly.
//   - The escape-hatch CCSM_TRANSPORT env-var: T6.10 (#76) owns it; the
//     bridge itself ships unconditionally with no feature flag.
//
// Layout / SRP:
//   - producer: `http2.createServer` accepting renderer streams.
//   - decider: `enforceAuthority` — pure function `(authority, expected)
//     → ok|reject` driven by string equality (no I/O, no side effects).
//   - sink: `forwardStream` — wires a renderer-side stream to the
//     daemon-side `clientHttp2Stream`. One concern (forward bytes) per
//     side; backpressure handled by `pipe()`.

import * as http2 from 'node:http2';
import * as net from 'node:net';
import { AddressInfo } from 'node:net';

import type { DescriptorTransport } from './protocol-app.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Daemon endpoint description — the subset of the descriptor the bridge
 * needs to dial out. Constructed by the boot wiring (T6.6) from the
 * full `DescriptorV1` after the descriptor is read from disk.
 *
 * We deliberately accept a structural type rather than `DescriptorV1`
 * itself so this file does not carry the full descriptor schema in its
 * test fixtures — bridge unit tests only need the four fields below.
 */
export interface DaemonEndpoint {
  /** Descriptor transport kind (closed enum from chapter 03 §1a). */
  readonly transport: DescriptorTransport;
  /**
   * Wire address.
   *   - KIND_UDS / KIND_NAMED_PIPE: the socket / pipe path (passed to
   *     `net.connect(<path>)`).
   *   - KIND_TCP_LOOPBACK_H2C / KIND_TCP_LOOPBACK_H2_TLS: `host:port`.
   */
  readonly address: string;
  /**
   * Optional fingerprint pin — only meaningful for KIND_TCP_LOOPBACK_H2_TLS.
   * The bridge does not implement TLS dial-out in v0.3 (the spike outcome
   * locked the TLS path as a fallback we do not exercise in the renderer
   * boot path); we surface the field here so a future TLS dial-out can
   * read it without changing the public surface.
   */
  readonly tlsCertFingerprintSha256: string | null;
}

/** Options for `startBridge`. */
export interface StartBridgeOptions {
  /** Daemon endpoint the bridge dials out to. */
  readonly daemon: DaemonEndpoint;
  /**
   * Optional override for the loopback host. Defaults to `127.0.0.1`.
   * Tests may pin to `127.0.0.1`; production callers MUST NOT change it.
   */
  readonly loopbackHost?: string;
  /**
   * Optional override for the bind port. Defaults to `0` (OS-assigned
   * ephemeral). Tests pinning to a fixed port are discouraged because
   * port-collision flake is hard to debug.
   */
  readonly listenPort?: number;
  /**
   * Logger sink. Defaults to no-op so unit tests do not spam stderr.
   * Real boot wiring (T6.6) plugs in the structured logger.
   */
  readonly log?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

/** Handle returned by `startBridge`. */
export interface BridgeHandle {
  /** `http://127.0.0.1:<port>` — what T6.1 rewrites the descriptor to. */
  readonly rendererUrl: string;
  /** Bound port. Useful for tests / logs. */
  readonly port: number;
  /** Bound host. Always `127.0.0.1` in production. */
  readonly host: string;
  /** Stop the bridge — closes the renderer-facing server AND the daemon
   *  client session. Resolves once both are fully closed. Idempotent. */
  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Pure helpers — testable without a server
// ---------------------------------------------------------------------------

/**
 * Decide whether a request's `:authority` (or HTTP/1.1 `Host:`) header
 * matches the bridge's bound endpoint. Pure; no I/O.
 *
 * Per RFC 9113 §8.1.1 the http2 layer normalises `Host:` into `:authority`
 * for us — Node's `http2` server exposes it as `headers[':authority']`.
 * We still belt-and-suspender against `headers['host']` because some
 * clients (notably HTTP/1.1 ones — h2c upgrade NOT enabled here, but
 * defensive) may send it untouched.
 *
 * Match rule: case-insensitive byte-equality against
 * `<expectedHost>:<expectedPort>`. We do NOT accept a missing port (the
 * renderer always knows the bridge port — it got it from the descriptor),
 * we do NOT accept `localhost` (only the literal IP — see chapter 08 §4.2
 * "bound on `127.0.0.1` only"), and we do NOT accept IPv6 forms.
 */
export function authorityMatches(
  authorityHeader: string | string[] | undefined,
  hostHeader: string | string[] | undefined,
  expectedHost: string,
  expectedPort: number,
): boolean {
  const expected = `${expectedHost}:${expectedPort}`.toLowerCase();
  const candidate =
    pickFirstString(authorityHeader) ?? pickFirstString(hostHeader);
  if (candidate === undefined) return false;
  return candidate.toLowerCase() === expected;
}

function pickFirstString(v: string | string[] | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === 'string') return v;
  return v[0];
}

/**
 * Build the `createConnection` factory the daemon-side `http2.connect`
 * needs. For UDS / named-pipe transports we open a socket against the
 * descriptor path; for h2c-loopback we let `http2.connect` use its
 * default TCP dialer (returns undefined).
 *
 * Exported for tests so the per-transport branch can be asserted without
 * spinning up a real daemon socket of every variant.
 */
export function buildDaemonConnectionFactory(
  endpoint: DaemonEndpoint,
): (() => net.Socket) | undefined {
  switch (endpoint.transport) {
    case 'KIND_UDS':
    case 'KIND_NAMED_PIPE':
      // Same code path on both POSIX UDS and Windows named pipes — Node's
      // `net.connect(<path>)` chooses the right syscall under the hood.
      return () => net.connect(endpoint.address);
    case 'KIND_TCP_LOOPBACK_H2C':
      // Default TCP dialer is fine; encoded by `http2.connect`'s
      // authority parsing of `http://host:port`.
      return undefined;
    case 'KIND_TCP_LOOPBACK_H2_TLS':
      // v0.3 does not exercise TLS dial-out from the bridge — the spike
      // locked TCP h2c / UDS / named-pipe as the production paths and
      // TLS as a fallback we do not reach in the renderer boot. We
      // surface a clear error rather than silently downgrading.
      throw new Error(
        'transport-bridge: KIND_TCP_LOOPBACK_H2_TLS dial-out not implemented in v0.3 ' +
          '(spike outcome — see ch03 §3.1 + ch08 §4.2)',
      );
  }
}

/**
 * Compute the `:authority` value the bridge sends to the daemon when
 * forwarding a request. For UDS / named-pipe there is no real authority,
 * so we send a stable sentinel that the daemon's listener accepts (the
 * Connect-RPC routing is path-based, not authority-based, and the
 * daemon-side server does not authority-check). For loopback-TCP we
 * pass the literal `host:port` so the daemon's logs are accurate.
 */
export function daemonAuthority(endpoint: DaemonEndpoint): string {
  switch (endpoint.transport) {
    case 'KIND_UDS':
    case 'KIND_NAMED_PIPE':
      // Match the convention the daemon test fixtures use
      // (`tools/spike-harness/probes/uds-h2c/client.mjs` →
      // `http://uds.invalid` / `http://pipe.invalid`).
      return endpoint.transport === 'KIND_UDS' ? 'uds.invalid' : 'pipe.invalid';
    case 'KIND_TCP_LOOPBACK_H2C':
    case 'KIND_TCP_LOOPBACK_H2_TLS':
      return endpoint.address;
  }
}

/**
 * Build the URL `http2.connect` uses. Node insists on a URL even for
 * UDS / named-pipe (the authority is consumed by `createConnection`,
 * not by DNS).
 */
export function daemonUrl(endpoint: DaemonEndpoint): string {
  return `http://${daemonAuthority(endpoint)}`;
}

// ---------------------------------------------------------------------------
// Bridge factory
// ---------------------------------------------------------------------------

const HOP_BY_HOP_HEADERS = new Set([
  // Pseudo-headers — http2 layer rejects them as request headers; we strip
  // before forwarding so a misbehaved renderer doesn't break the proxy.
  ':method',
  ':scheme',
  ':path',
  ':authority',
  // HTTP/1.1 hop-by-hop list (RFC 9110 §7.6.1). Most are h1-only but
  // stripping them on the h2 ↔ h2 hop is safe and defensive.
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * Strip headers that must not be forwarded across the bridge hop. Pure;
 * exported for tests.
 */
export function stripHopByHop(
  headers: http2.IncomingHttpHeaders,
): http2.OutgoingHttpHeaders {
  const out: http2.OutgoingHttpHeaders = {};
  for (const [k, v] of Object.entries(headers)) {
    if (HOP_BY_HOP_HEADERS.has(k.toLowerCase())) continue;
    if (v === undefined) continue;
    out[k] = v;
  }
  return out;
}

/**
 * Spin up the bridge. Returns once the renderer-facing server is bound
 * AND the daemon-side client session is connected (so the first renderer
 * request does not race the daemon connect).
 */
export async function startBridge(
  opts: StartBridgeOptions,
): Promise<BridgeHandle> {
  const host = opts.loopbackHost ?? '127.0.0.1';
  const port = opts.listenPort ?? 0;
  const log = opts.log ?? noopLog;

  // ---- Daemon-side client session ---------------------------------------
  // We hold ONE long-lived session and re-create on close. The renderer
  // multiplexes streams over this single h2 connection, mirroring how a
  // direct renderer→daemon connection would behave if Chromium could speak
  // UDS. If the daemon restarts the session emits 'close' and our error
  // path closes inbound streams; renderer retry (chapter 08 §6) handles
  // the reconnect.

  const connectionFactory = buildDaemonConnectionFactory(opts.daemon);
  const dUrl = daemonUrl(opts.daemon);

  let daemonSession: http2.ClientHttp2Session | null = null;
  let daemonSessionReady: Promise<http2.ClientHttp2Session> | null = null;

  function openDaemonSession(): Promise<http2.ClientHttp2Session> {
    if (daemonSession && !daemonSession.closed && !daemonSession.destroyed) {
      return Promise.resolve(daemonSession);
    }
    if (daemonSessionReady) return daemonSessionReady;
    daemonSessionReady = new Promise<http2.ClientHttp2Session>(
      (resolve, reject) => {
        const session = http2.connect(dUrl, {
          ...(connectionFactory ? { createConnection: connectionFactory } : {}),
        });
        const onError = (err: Error): void => {
          session.removeListener('connect', onConnect);
          daemonSessionReady = null;
          reject(err);
        };
        const onConnect = (): void => {
          session.removeListener('error', onError);
          daemonSession = session;
          daemonSessionReady = null;
          // Reset on close so the next request triggers a fresh dial. We
          // do NOT auto-reconnect inside the bridge — the renderer's
          // React Query layer (chapter 08 §6) drives retry.
          session.once('close', () => {
            if (daemonSession === session) daemonSession = null;
            log('warn', 'transport-bridge: daemon session closed');
          });
          resolve(session);
        };
        session.once('error', onError);
        session.once('connect', onConnect);
      },
    );
    return daemonSessionReady;
  }

  // Eagerly open the daemon session so startBridge() resolves only after
  // both sides are wired. If the daemon is still booting the call rejects
  // and the boot wiring (T6.6) can decide to retry / show the cold-start
  // modal (chapter 08 §6.1). We intentionally do not silently swallow.
  await openDaemonSession();

  // ---- Renderer-facing server ------------------------------------------
  const server = http2.createServer();

  server.on(
    'stream',
    (rendererStream: http2.ServerHttp2Stream, headers, _flags) => {
      // ---- Host / authority enforcement -------------------------------
      // Compute against the live bound port so a future caller passing
      // `listenPort` in opts cannot trick us out of the equality.
      const addr = server.address() as AddressInfo | null;
      if (!addr || typeof addr === 'string' || typeof addr.port !== 'number') {
        // Should be impossible — server fired 'stream' so it is bound.
        // Defensive fast-fail rather than risk forwarding without a check.
        rendererStream.respond({ ':status': 500 });
        rendererStream.end();
        return;
      }

      if (
        !authorityMatches(
          headers[':authority'],
          headers['host'],
          host,
          addr.port,
        )
      ) {
        // RFC 9110 §15.5.20 — 421 Misdirected Request. We close the
        // stream cleanly with no body (the renderer treats any 4xx
        // here as a fatal misconfiguration; chapter 08 §4.2 locks
        // mismatch as a structural DNS-rebind defense, not a soft
        // recoverable error).
        rendererStream.respond({ ':status': 421 }, { endStream: true });
        log(
          'warn',
          `transport-bridge: rejected stream with bad authority "${
            String(headers[':authority']) || String(headers['host']) || '<absent>'
          }" (expected ${host}:${addr.port})`,
        );
        return;
      }

      // ---- Forward to daemon ------------------------------------------
      openDaemonSession().then(
        (session) => forwardStream(rendererStream, session, headers, log),
        (err: Error) => {
          log('error', `transport-bridge: daemon connect failed: ${err.message}`);
          if (!rendererStream.destroyed) {
            rendererStream.respond({ ':status': 502 }, { endStream: true });
          }
        },
      );
    },
  );

  // Bind. Reject the promise rather than crashing the main process if the
  // listen call fails (port collision, EACCES on the loopback in some
  // hardened sandboxes, etc.). T6.6 handles the boot-time retry policy.
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });

  const addr = server.address() as AddressInfo | null;
  if (!addr || typeof addr === 'string' || typeof addr.port !== 'number') {
    // Defensive — listen resolved but address() returned a non-port; this
    // would mean the OS bound a UDS, which we never request.
    server.close();
    throw new Error('transport-bridge: failed to obtain bound TCP port');
  }
  const boundPort = addr.port;
  log('info', `transport-bridge: listening on ${host}:${boundPort}`);

  let closed = false;
  const closeFn = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (daemonSession && !daemonSession.destroyed) {
      await new Promise<void>((resolve) => {
        daemonSession!.close(() => resolve());
      });
    }
  };

  return {
    rendererUrl: `http://${host}:${boundPort}`,
    port: boundPort,
    host,
    close: closeFn,
  };
}

// ---------------------------------------------------------------------------
// Stream forwarding
// ---------------------------------------------------------------------------

/**
 * Forward a renderer-side inbound http2 stream to a freshly-opened
 * daemon-side client stream. Both directions of bytes proxy through;
 * trailers are forwarded; resets propagate.
 *
 * Exported only so the spec test can drive it directly with synthetic
 * streams if needed; production callers go through `startBridge`.
 */
export function forwardStream(
  rendererStream: http2.ServerHttp2Stream,
  daemonSession: http2.ClientHttp2Session,
  rendererHeaders: http2.IncomingHttpHeaders,
  log: (level: 'info' | 'warn' | 'error', msg: string) => void = noopLog,
): void {
  const outboundHeaders = stripHopByHop(rendererHeaders);
  outboundHeaders[':method'] = String(rendererHeaders[':method'] ?? 'POST');
  outboundHeaders[':path'] = String(rendererHeaders[':path'] ?? '/');
  outboundHeaders[':scheme'] = 'http';
  // Authority on the daemon side is consumed by createConnection for
  // UDS / named-pipe; for loopback-TCP we let http2 derive it from the
  // session URL (no override needed).

  let daemonStream: http2.ClientHttp2Stream;
  try {
    daemonStream = daemonSession.request(outboundHeaders, { endStream: false });
  } catch (err) {
    log('error', `transport-bridge: daemon request open failed: ${(err as Error).message}`);
    if (!rendererStream.destroyed) {
      rendererStream.respond({ ':status': 502 }, { endStream: true });
    }
    return;
  }

  // Renderer → Daemon: pipe request body (DATA frames). The renderer side
  // is a Duplex; the daemon side is a Duplex. `pipe()` propagates
  // backpressure (pause/resume) without us buffering.
  rendererStream.pipe(daemonStream);

  // When daemon responds with headers (status + content-type + ...), echo
  // them back to the renderer.
  daemonStream.on('response', (responseHeaders) => {
    if (rendererStream.destroyed) return;
    const headersOut = stripHopByHop(responseHeaders);
    const status = Number(responseHeaders[':status'] ?? 200);
    delete (headersOut as Record<string, unknown>)[':status'];
    rendererStream.respond({ ':status': status, ...headersOut });
  });

  // Daemon → Renderer: pipe response body. We do NOT call
  // rendererStream.end() ourselves — the daemon stream's 'end' will
  // close the writable side via pipe.
  daemonStream.pipe(rendererStream);

  // Trailers — Connect uses HTTP trailers for end-of-RPC status; forward
  // them so the renderer's Connect client sees the daemon's verdict.
  daemonStream.on('trailers', (trailers) => {
    if (rendererStream.destroyed) return;
    try {
      rendererStream.sendTrailers(trailers as http2.OutgoingHttpHeaders);
    } catch (err) {
      // sendTrailers throws if response headers were never sent (daemon
      // returned trailers without HEADERS). Log and let the stream close.
      log('warn', `transport-bridge: sendTrailers failed: ${(err as Error).message}`);
    }
  });

  // Error / reset propagation — if either side errors, tear down the
  // other so we do not leak half-open streams. We close with cancel
  // (CANCEL = 0x8) which the Connect client interprets as `canceled`.
  rendererStream.on('error', (err) => {
    log('warn', `transport-bridge: renderer stream error: ${err.message}`);
    if (!daemonStream.destroyed) daemonStream.close(http2.constants.NGHTTP2_CANCEL);
  });
  daemonStream.on('error', (err) => {
    log('warn', `transport-bridge: daemon stream error: ${err.message}`);
    if (!rendererStream.destroyed) rendererStream.close(http2.constants.NGHTTP2_CANCEL);
  });
  rendererStream.on('close', () => {
    if (!daemonStream.destroyed) daemonStream.close(http2.constants.NGHTTP2_NO_ERROR);
  });
  daemonStream.on('close', () => {
    if (!rendererStream.destroyed) rendererStream.close(http2.constants.NGHTTP2_NO_ERROR);
  });
}

function noopLog(_level: 'info' | 'warn' | 'error', _msg: string): void {
  /* no-op */
}
