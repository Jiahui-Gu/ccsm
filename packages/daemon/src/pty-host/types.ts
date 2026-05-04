// IPC message shapes between daemon main process and per-session pty-host
// child. Spec ch06 §1 (per-session topology, child_process.fork boundary).
//
// T4.1 scope: lifecycle-only stubs (ready / exiting / spawn / close /
// send-input / resize). T-PA-1 (spec
// `2026-05-04-pty-attach-handler.md` §9.1) extends the child→host union
// with full payloads for the previously reserved `'delta'` /
// `'snapshot'` / `'send-input-rejected'` kinds so the Attach handler
// (T-PA-5/T-PA-6) and the child-side emitter (T-PA-8) have a single
// pinned IPC surface to compile against. The discriminant strings did
// NOT change — they were already reserved in T4.1 — so existing
// `isChildToHostMessage` guards and `switch` statements in `host.ts` /
// `child.ts` remain exhaustive without code edits beyond payload
// access.
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
  | DeltaMessage
  | SnapshotMessage
  | SendInputRejectedMessage;

/**
 * One delta segment produced by the pty-host child. Mirrors `PtyDelta`
 * on the wire (`packages/proto/src/ccsm/v1/pty.proto`) but stays in
 * native JS types (`bigint`, `Uint8Array`) — proto encoding happens at
 * the Connect handler boundary in `rpc/pty-attach.ts`, never inside the
 * IPC layer.
 *
 * Contract (spec `2026-05-04-pty-attach-handler.md` §2.1, §2.2):
 * - `seq` is monotonically increasing per session, starting at `1`
 *   after the most recent snapshot's `baseSeq`. Never reused, never
 *   gapped. Maps to `PtyDelta.seq` (proto `uint64`).
 * - `tsUnixMs` is the wall-clock capture timestamp; maps to
 *   `PtyDelta.ts_unix_ms` (proto `int64`).
 * - `payload` is the raw VT byte chunk (ch06 §3); opaque to the daemon
 *   main process. Sent as a `Uint8Array` because IPC uses
 *   `serialization: 'advanced'` (structured clone), so no base64 cost.
 */
export interface DeltaMessage {
  readonly kind: 'delta';
  readonly seq: bigint;
  readonly tsUnixMs: bigint;
  readonly payload: Uint8Array;
}

/**
 * One snapshot produced by the pty-host child. Mirrors `PtySnapshot`
 * on the wire but in native JS types.
 *
 * Contract (spec §2.2, §2.4, §3.3):
 * - `baseSeq` equals the seq of the last delta emitted before this
 *   snapshot was captured (so a subsequent Attach handler resumes
 *   live deltas at `baseSeq + 1n`). The synthetic initial snapshot
 *   captured on `'ready'` (§3.3) uses `baseSeq = 0n` because no
 *   deltas have been emitted yet.
 * - `geometry` reflects the PTY geometry at capture time.
 * - `screenState` is the SnapshotV1 wire bytes from the codec
 *   package (ch06 §2), already zstd-wrapped. Opaque to the daemon
 *   main process.
 * - `schemaVersion` is `1` in v0.3; bumps with codec evolution.
 */
export interface SnapshotMessage {
  readonly kind: 'snapshot';
  readonly baseSeq: bigint;
  readonly geometry: { readonly cols: number; readonly rows: number };
  readonly screenState: Uint8Array;
  readonly schemaVersion: number;
}

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
