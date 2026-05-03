// HTTP/2 transport adapters — common shape (spec ch03 §4 transport options
// A1-A4: h2c-UDS / h2c-loopback / h2-named-pipe / h2-TLS).
//
// T1.5 scope: pure transport binding adapters. Each adapter takes a
// pre-built `http2.Http2Server` (or `Http2SecureServer` for TLS) and
// binds it to an OS-specific socket address. No factory glue lives in
// this module — the per-OS switch (which adapter to instantiate) lives
// in T1.4's `makeListenerA` factory, deliberately so that swapping
// between A1/A2/A3/A4 is a 2-file diff (factory + descriptor writer)
// per spec ch03 §4 zero-rework rule.
//
// SRP: each adapter is a `sink` that wires the server's `connection`
// event onto a concrete OS socket. No protocol decisions, no auth, no
// peer-cred resolution — those are the listener's concern (T1.4 / T1.7).
//
// Layer 1: node: stdlib only (`node:http2`, `node:net`, `node:tls`,
// `node:fs`). No third-party transport library — Connect-RPC consumes
// the resulting `Http2Server` directly via `@connectrpc/connect-node`'s
// `connectNodeAdapter` (wired by T1.4, not here).

import type { Http2Server, Http2SecureServer } from 'node:http2';

/**
 * Bind specs — narrow, per-adapter input shapes. Each adapter accepts
 * exactly one shape; the factory (T1.4) chooses which adapter to call
 * based on the per-OS BindDescriptor in `DaemonEnv`.
 *
 * Shapes mirror the BindDescriptor closed enum (listeners/types.ts) but
 * are intentionally separate types to keep the transport layer
 * decoupled from the listener-trait module — adapters here never
 * import from `../listeners/`.
 */
export interface UdsBindSpec {
  /** Filesystem path of the UDS (e.g. `/run/ccsm/daemon.sock`). */
  readonly path: string;
}

export interface LoopbackBindSpec {
  /** Loopback host. v0.3 always `127.0.0.1`; IPv6 ::1 reserved for v0.4. */
  readonly host: '127.0.0.1';
  /** Port number. `0` requests an ephemeral kernel-assigned port. */
  readonly port: number;
}

export interface NamedPipeBindSpec {
  /** Named-pipe path. Bare name (`ccsm-<sid>`) or full
   *  `\\.\pipe\<name>` / `\\?\pipe\<name>` accepted; adapter normalizes. */
  readonly pipeName: string;
}

export interface TlsBindSpec {
  /** Loopback host. v0.3 always `127.0.0.1`. */
  readonly host: '127.0.0.1';
  /** Port number. `0` requests an ephemeral kernel-assigned port. */
  readonly port: number;
  /** PEM-encoded server certificate. */
  readonly cert: string | Buffer;
  /** PEM-encoded private key. */
  readonly key: string | Buffer;
}

/**
 * Resolved address surface returned by every adapter after `bind()`.
 *
 * Discriminated by `kind` so the factory + descriptor writer can pick
 * the address shape exhaustively. The transport adapter is the SOLE
 * source of truth for the bound address (loopback ports may be
 * ephemeral; UDS paths may be canonicalized; TLS exposes the cert
 * fingerprint for descriptor pinning per spec ch03 §3.2 / §4 A3).
 */
export type BoundAddress =
  | { readonly kind: 'KIND_UDS'; readonly path: string }
  | { readonly kind: 'KIND_NAMED_PIPE'; readonly pipeName: string }
  | {
      readonly kind: 'KIND_TCP_LOOPBACK_H2C';
      readonly host: '127.0.0.1';
      readonly port: number;
    }
  | {
      readonly kind: 'KIND_TCP_LOOPBACK_H2_TLS';
      readonly host: '127.0.0.1';
      readonly port: number;
      /** SHA-256 hex fingerprint of the server cert (lowercase, no
       *  separators). Pinned by Electron per spec ch03 §3.2. */
      readonly certFingerprintSha256: string;
    };

/**
 * The handle a transport adapter returns after a successful `bind()`.
 *
 * Lifecycle: `address()` is callable any time after `bind()` resolves;
 * `close()` is idempotent and resolves once the underlying socket is
 * fully torn down (both the OS-level listener AND any in-flight
 * sessions are drained or destroyed). Calling `close()` twice is a
 * no-op that returns the same Promise.
 */
export interface BoundTransport {
  /** Resolved bind address. Stable for the lifetime of the binding. */
  address(): BoundAddress;
  /** Stop accepting new connections; tear down the underlying socket. */
  close(): Promise<void>;
}

/**
 * Adapter contract — every transport variant exports a `bind(server,
 * spec)` of this exact shape. The factory (T1.4) keys on the OS / spike
 * outcome to pick which adapter to import.
 *
 * The `server` argument is whatever http2 server kind the adapter
 * accepts — h2c adapters take a plaintext `Http2Server`, the TLS
 * adapter takes an `Http2SecureServer`. Each adapter's exported
 * `bind` narrows this generically.
 */
export type TransportAdapter<S, Spec> = (
  server: S,
  spec: Spec,
) => Promise<BoundTransport>;

/**
 * h2c-only server kind — used by UDS / loopback / named-pipe adapters.
 * Re-exported so the factory has a single import surface.
 */
export type H2cServer = Http2Server;

/** TLS server kind — used by the TLS adapter only. */
export type H2TlsServer = Http2SecureServer;
