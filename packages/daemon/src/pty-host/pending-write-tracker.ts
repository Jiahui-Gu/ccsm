// Per-session pending-write byte tracker for the pty-host child.
//
// Spec ref:
//   - docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//     ch06 §1 FOREVER-STABLE row F5 — "PTY input backpressure":
//       per-session pending-write byte cap of **1 MiB** on the node-pty
//       master write queue. The pty-host child tracks pendingWriteBytes
//       (sum of bytes passed to master.write(buf) minus bytes drained
//       per node-pty's drain event). On SendInput, if
//       pendingWriteBytes + bytes.length > 1 MiB, reject with
//       RESOURCE_EXHAUSTED + crash_log("pty_input_overflow"); NO bytes
//       from this SendInput are written.
//   - docs/superpowers/specs/2026-05-04-pty-attach-handler.md §2.2
//     SendInputRejectedMessage payload shape (locked: pendingWriteBytes
//     + attemptedBytes).
//
// SRP (dev.md §2): this module is a pure decider + a tiny piece of
// state. It owns ZERO I/O — `decide(attemptedBytes)` is a pure function
// of (currentPending, attemptedBytes, cap). The state mutators
// (`recordWrite`, `recordDrain`) are explicit calls; the producer of
// drain events (the writer wrapping node-pty) and the sink that emits
// the IPC rejection (`child.ts`) live elsewhere. This split mirrors how
// `decideWatchScope` is paired with the watch-sessions emitter.
//
// Layer 1 — alternatives checked:
//   - `node:stream`'s Writable.writableLength + write() returning false
//     LOOKS like the same primitive, but node-pty's IPty surface is NOT
//     a Node Writable — it has no `drain` event nor `writableLength`
//     accessor. We MUST track bytes ourselves. Confirmed by reading
//     node-pty IPty interface (no Writable inheritance).
//   - A bespoke ring/queue is overkill; the cap is byte-based, not
//     entry-based. A single i32-safe counter suffices.
//   - The cap (1 MiB = 1048576) is FOREVER-STABLE per spec; exposed as
//     a const here so tests / docs can import the same number.

/** Per-session pending-write cap. FOREVER-STABLE per spec ch06 §1 F5. */
export const PENDING_WRITE_CAP_BYTES = 1024 * 1024; // 1 MiB

/**
 * Verdict from `PendingWriteTracker.decide`.
 *
 *   - `accept`: caller MUST follow up with `recordWrite(attempted)`
 *     before passing the bytes to the underlying writer. (Decoupling
 *     decide from recordWrite keeps decide pure for testing.)
 *   - `reject`: caller MUST NOT write any bytes; it MUST emit
 *     `send-input-rejected` IPC with this verdict's payload fields.
 */
export type WriteAdmissionVerdict =
  | { readonly kind: 'accept' }
  | {
      readonly kind: 'reject';
      readonly reason: 'pty.input_overflow';
      readonly pendingWriteBytes: number;
      readonly attemptedBytes: number;
      readonly capBytes: number;
    };

/**
 * Tracker holding the per-session pending-write tally.
 *
 * Lifecycle: one instance per pty-host child (one session per child per
 * spec ch06 §1). The instance is created at child boot, before any
 * `send-input` IPC can land, and lives until the child exits.
 */
export class PendingWriteTracker {
  private pending = 0;

  constructor(
    /** Cap in bytes; defaults to the spec's 1 MiB. Tests pin a small
     *  cap to keep fixture data small. */
    private readonly capBytes: number = PENDING_WRITE_CAP_BYTES,
  ) {
    if (!Number.isInteger(capBytes) || capBytes <= 0) {
      throw new Error(
        `PendingWriteTracker: capBytes must be a positive integer (got ${capBytes})`,
      );
    }
  }

  /** Current pending tally (bytes passed to writer minus bytes drained). */
  get pendingWriteBytes(): number {
    return this.pending;
  }

  /** Configured cap (bytes). */
  get cap(): number {
    return this.capBytes;
  }

  /**
   * Pure decider — returns the admission verdict for an incoming
   * `send-input` of `attemptedBytes` bytes. Does NOT mutate state.
   *
   * Reject when `pending + attempted > cap`. Equality (`pending +
   * attempted == cap`) is allowed: the spec wording is "if
   * pendingWriteBytes + bytes.length > 1 MiB" so the cap is inclusive.
   */
  decide(attemptedBytes: number): WriteAdmissionVerdict {
    if (
      !Number.isInteger(attemptedBytes) ||
      attemptedBytes < 0
    ) {
      throw new Error(
        `PendingWriteTracker.decide: attemptedBytes must be a non-negative integer (got ${attemptedBytes})`,
      );
    }
    if (this.pending + attemptedBytes > this.capBytes) {
      return {
        kind: 'reject',
        reason: 'pty.input_overflow',
        pendingWriteBytes: this.pending,
        attemptedBytes,
        capBytes: this.capBytes,
      };
    }
    return { kind: 'accept' };
  }

  /**
   * Record `bytes` as in-flight (written to the underlying pty master,
   * not yet drained). Caller invokes this immediately after a successful
   * `decide` → 'accept' AND a successful `writer.write(buf)`.
   */
  recordWrite(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new Error(
        `PendingWriteTracker.recordWrite: bytes must be a non-negative integer (got ${bytes})`,
      );
    }
    this.pending += bytes;
  }

  /**
   * Record `bytes` as drained (the kernel pty buffer accepted them and
   * the node-pty `drain` event fired with that count). Clamps at zero —
   * a buggy producer over-draining cannot push the tally negative.
   */
  recordDrain(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0) {
      throw new Error(
        `PendingWriteTracker.recordDrain: bytes must be a non-negative integer (got ${bytes})`,
      );
    }
    this.pending = Math.max(0, this.pending - bytes);
  }

  /** Reset tally to zero. Only used in tests; production lifecycle
   *  matches the child process lifetime so reset is unnecessary. */
  resetForTest(): void {
    this.pending = 0;
  }
}
