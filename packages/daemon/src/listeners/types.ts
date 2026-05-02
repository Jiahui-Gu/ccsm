// Listener trait + BindDescriptor closed-enum union — spec ch03 §1
// (Listener trait shape) + §1a (BindDescriptor closed enum).
//
// T1.2 scope: types + sentinel surface only. The concrete Listener A
// factory (T1.4), HTTP/2 transports (T1.5), and the ESLint
// `no-listener-slot-mutation` rule (T1.9) all live in separate tasks.
//
// Layer 1 / SRP: this module is pure type declarations — no runtime
// behavior, no side effects. The Listener trait is a small surface
// (start / stop / descriptor) and intentionally does not mention
// transport details — those belong to BindDescriptor.

/**
 * Closed-enum union of every transport shape the daemon will ever bind.
 * Adding a new variant is a deliberate spec change (ch03 §1a) — the
 * closed shape lets `switch (d.kind)` typecheck exhaustively in
 * downstream consumers (descriptor writer T1.4, ops tooling).
 *
 * Variants:
 *   - `uds`        : POSIX Unix Domain Socket (Linux / macOS).
 *   - `namedPipe`  : Windows named pipe (`\\.\pipe\<name>`).
 *   - `loopbackTcp`: 127.0.0.1 / ::1 TCP — dev / debug only.
 *   - `tls`        : TLS-over-TCP — reserved for v0.4 Listener B.
 */
export type BindDescriptor =
  | { readonly kind: 'uds'; readonly path: string }
  | { readonly kind: 'namedPipe'; readonly pipeName: string }
  | { readonly kind: 'loopbackTcp'; readonly host: '127.0.0.1' | '::1'; readonly port: number }
  | {
      readonly kind: 'tls';
      readonly host: string;
      readonly port: number;
      /** PEM-encoded server certificate path. */
      readonly certPath: string;
      /** PEM-encoded private key path. */
      readonly keyPath: string;
    };

/**
 * Listener trait — the shape every transport listener must satisfy.
 * Spec ch03 §1.
 *
 * Lifecycle: callers construct via a factory (e.g. `makeListenerA(env)`
 * in T1.4), then `start()` once during phase STARTING_LISTENERS, and
 * `stop()` exactly once during graceful shutdown (T1.8). Calling
 * `start()` twice or `stop()` before `start()` is a programming error
 * — implementations may throw.
 *
 * `descriptor()` returns the bind shape AFTER a successful `start()`
 * (port may be ephemeral until the OS assigns it). Calling before
 * `start()` is a programming error.
 */
export interface Listener {
  /** Stable id used in logs / descriptor file (`listener-a`, `listener-b`). */
  readonly id: string;
  /** Bind the transport. Idempotent-fail: throws on second call. */
  start(): Promise<void>;
  /** Tear down the transport. Idempotent: safe to call after a failed start. */
  stop(): Promise<void>;
  /** Resolved bind descriptor (only valid after `start()`). */
  descriptor(): BindDescriptor;
}

// Re-export the sentinel from env.ts so listener-array consumers have a
// single import surface (`./listeners/types`) without reaching back into
// the env module. The sentinel itself was minted in T1.1 (env.ts) so the
// DaemonEnv shape could pin slot 1 without depending on T1.2 code.
export { RESERVED_FOR_LISTENER_B, type ReservedForListenerB } from '../env.js';
