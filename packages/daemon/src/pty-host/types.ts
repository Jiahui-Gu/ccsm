// IPC message shapes between daemon main process and per-session pty-host
// child. Spec ch06 §1 (per-session topology, child_process.fork boundary).
//
// T4.1 scope: lifecycle-only stubs. The host→child messages cover spawn
// hand-off and graceful close; the child→host messages cover ready
// handshake and structured exit signalling. Snapshot / delta / SendInput
// payloads are intentionally NOT defined here — they wire up in T4.6+
// alongside the SnapshotV1 codec and PtyService Connect handlers. Adding
// them now would either (a) freeze a wire shape before the codec lands,
// or (b) ship a half-defined surface that gets renamed in T4.6. Either
// is a v0.4 zero-rework violation; instead this file only enumerates the
// closed-discriminant `kind` strings reserved for those later messages so
// the switch statements in `host.ts` / `child.ts` stay exhaustive when
// T4.6 fills the payloads in.
//
// SRP: this module is pure type declarations — no runtime, no I/O.

/**
 * Message kinds the daemon main process sends to a pty-host child over
 * the `child_process.fork` IPC channel. The discriminant is intentionally
 * a string literal (not a numeric enum) so messages survive the JSON
 * envelope `child_process.fork` wraps each value in.
 */
export type HostToChildKind =
  /** Hand off the spawn parameters; child responds with `ready`. */
  | 'spawn'
  /** Request graceful shutdown; child cleans up and exits 0. */
  | 'close'
  /** Forward bytes from a `SendInput` RPC — payload lands in T4.6+. */
  | 'send-input'
  /** Forward a `Resize` RPC — payload lands in T4.10. */
  | 'resize';

/**
 * Message kinds a pty-host child sends back to the daemon main process.
 * Same discriminant rules as `HostToChildKind`.
 */
export type ChildToHostKind =
  /** Child finished init (node-pty / xterm-headless ready). */
  | 'ready'
  /** A delta segment is available — payload lands in T4.9. */
  | 'delta'
  /** A snapshot is available — payload lands in T4.6 / T4.10. */
  | 'snapshot'
  /** Backpressure rejection from the per-session 1 MiB cap (T4.3). */
  | 'send-input-rejected'
  /** Structured pre-exit signal so the daemon can distinguish graceful
   *  close from crash even before `child.on('exit')` fires (T4.4). */
  | 'exiting';

/**
 * Hand-off payload for the `spawn` message. Forever-stable in shape; the
 * extension points (env, args) are open-ended maps on purpose so the
 * UTF-8 contract (T4.2) and per-OS argv shaping (Windows `chcp 65001`
 * wrapper) can land without re-typing this surface.
 */
export interface SpawnPayload {
  /** Session id this child owns; used in log lines and crash_log rows. */
  readonly sessionId: string;
  /** Working directory for the `claude` CLI subprocess. */
  readonly cwd: string;
  /** Argv for the `claude` CLI (does NOT include the `chcp 65001` wrapper
   *  on Windows — the child computes that itself per ch06 §1). */
  readonly claudeArgs: readonly string[];
  /** Initial PTY geometry (cols × rows). Resized later via `resize`. */
  readonly cols: number;
  readonly rows: number;
  /** Caller-provided env *additions* on top of the UTF-8 contract; a
   *  duplicate key here loses to the UTF-8 contract value computed by
   *  `pty-host/spawn-env.ts`. v0.3 daemon does not use this field; it
   *  exists so v0.4 multi-principal helpers can pass per-principal env
   *  without changing the message shape. */
  readonly envExtra?: Readonly<Record<string, string>>;
}

/** Closed union of every host→child message. */
export type HostToChildMessage =
  | { readonly kind: 'spawn'; readonly payload: SpawnPayload }
  | { readonly kind: 'close' }
  | { readonly kind: 'send-input'; readonly bytes: Uint8Array }
  | { readonly kind: 'resize'; readonly cols: number; readonly rows: number };

/**
 * Backpressure rejection message — T4.3.
 *
 * Emitted by the pty-host child when a `send-input` would push the
 * per-session pending-write tally past the 1 MiB cap (spec ch06 §1
 * FOREVER-STABLE row F5). The daemon main process maps this into a
 * Connect `RESOURCE_EXHAUSTED` reply on the originating `SendInput` RPC
 * and writes a `crash_log` row with `source = "pty_input_overflow"`,
 * `summary` containing the `sessionId` (resolved by the daemon main
 * process from the `PtyHostChildHandle` that owns this child) and
 * `pendingWriteBytes`. NO bytes from the rejected `SendInput` are ever
 * passed to the node-pty master.
 *
 * Wire shape is locked here (matches docs/superpowers/specs/2026-05-04
 * -pty-attach-handler.md §2.2 SendInputRejectedMessage — flat fields,
 * no nested `payload`, no `sessionId`; the child→daemon-main IPC is
 * one-to-one with a session and the daemon already knows which child
 * sent the message). v0.4 may add fields additively but MUST NOT
 * rename / renumber.
 */
export interface SendInputRejectedMessage {
  readonly kind: 'send-input-rejected';
  /** Current pending-write tally at the moment of rejection (bytes). */
  readonly pendingWriteBytes: number;
  /** Size of the rejected `send-input` payload in bytes. */
  readonly attemptedBytes: number;
}

/** Closed union of every child→host message. */
export type ChildToHostMessage =
  | { readonly kind: 'ready'; readonly sessionId: string; readonly pid: number }
  | { readonly kind: 'exiting'; readonly reason: 'graceful' | 'test-crash' }
  /** Delta / snapshot variants are reserved kinds; their payload shape is
   *  intentionally unspecified at T4.1 and lands with the codec tasks.
   *  The discriminant is enumerated in {@link ChildToHostKind} so `switch`
   *  statements stay exhaustive. */
  | { readonly kind: 'delta' | 'snapshot' }
  | SendInputRejectedMessage;

/**
 * Reasons the daemon may observe for a child exit. Mirrors the spec's
 * ch06 §1 child-process crash semantics: graceful (matches a prior
 * `close` from the daemon) vs crash (any other path — non-zero exit,
 * signal, IPC disconnect without `exiting` notice).
 */
export type ChildExitReason = 'graceful' | 'crashed';

/** Outcome the host surface emits to its caller for each spawned child. */
export interface ChildExit {
  readonly reason: ChildExitReason;
  /** Process exit code if any; `null` if signal-killed or disconnected. */
  readonly code: number | null;
  /** Termination signal name if any (e.g. `'SIGKILL'`). */
  readonly signal: NodeJS.Signals | null;
}
