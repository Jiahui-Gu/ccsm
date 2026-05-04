// Per-session pty-host CHILD ENTRYPOINT — `child_process.fork`'d by the
// daemon main process via `host.ts`. Spec ch06 §1.
//
// T4.1 scope: lifecycle stub only.
//   - On boot, send `ready` once the IPC channel is up.
//   - Handle host→child messages; for T4.1, only `spawn` and `close` do
//     anything. `send-input` and `resize` are accepted (kept for forward
//     compat) but are no-ops with a debug log line — T4.3 / T4.10 fill
//     them in.
//   - On `close`, send `{kind:'exiting', reason:'graceful'}` then exit 0.
//
// T4.2 addition: on `spawn`, compute the per-OS `(file, args)` pair the
// future `node-pty.spawn` call will use (via `computeSpawnArgv`) and log
// it. The actual `node-pty` import + spawn lands in T4.6+; logging the
// resolved argv now means installer smoke tests + the 1-hour soak harness
// can grep the daemon stdout for the exact command line that *will* be
// spawned without depending on an unfinished module.
//
// T4.3 addition: SendInput backpressure 1 MiB cap (spec ch06 §1 F5).
//   - A `PendingWriteTracker` (1 MiB cap) is owned for the lifetime of
//     the child. A pluggable `PtyWriter` is its sink: in T4.3 the
//     default writer is a stub that simulates instant drain (real
//     node-pty wiring lands with T4.6+ which will inject a writer that
//     forwards `master.write(buf)` and observes the drain event).
//   - Every `send-input` IPC asks the tracker for an admission verdict;
//     reject → emit `send-input-rejected` IPC carrying `sessionId`,
//     `pendingWriteBytes`, `attemptedBytes`. NO bytes are forwarded to
//     the writer in the reject path. The daemon main process maps that
//     IPC into a Connect `RESOURCE_EXHAUSTED` reply on the originating
//     `SendInput` RPC and writes a `crash_log` row (source =
//     `pty_input_overflow`).
//
// T4.5 addition: test-only crash branch (`CCSM_PTY_TEST_CRASH_ON`).
//   - Spec ch06 §1 "Test-only crash branch (FOREVER-STABLE)": when the
//     env var is set AND `NODE_ENV !== 'production'`, the child crashes
//     with `process.exit(137)` at a configurable event so the daemon's
//     T4.4 child-crash semantics (state→CRASHED, no respawn, crash_log
//     row) can be exercised end-to-end without mocking the child.
//   - The parse + matching logic lives in `test-crash-config.ts` (pure
//     decider, SRP). This file only adds three one-line crash hooks
//     at the natural lifecycle points (`boot`, on `spawn` IPC, on
//     every child→host IPC byte for the `after-bytes:N` variant).
//   - Production gate is dual: env var presence AND NODE_ENV check;
//     prod sea builds inline `parseTestCrashEnv` and dead-code-strip
//     the entire branch since the env var is absent at boot.
//
// T-PA-8 addition (this PR; spec `2026-05-04-pty-attach-handler.md` §9.2):
// child-side delta + snapshot emission so the Attach handler (T-PA-5)
// has IPC traffic to broadcast.
//
//   1. Synthetic initial snapshot (§3.3 FOREVER-STABLE) — on `spawn`,
//      AFTER logging the resolved argv and BEFORE accepting any deltas,
//      send a `SnapshotMessage` with `baseSeq=0n`, geometry from the
//      spawn payload, schemaVersion=1, and an empty `screenState`.
//      The empty screenState is a deliberate stub: the SnapshotV1 codec
//      (T4.6) lands in a parallel wave and is not wired here yet; once
//      the codec ships, this site swaps `new Uint8Array(0)` for
//      `encodeSnapshotV1(xterm.serialize())` with no IPC shape change
//      (`screenState` is opaque bytes per `types.ts`).
//
//   2. Delta accumulation (ch06 §3) — a `DeltaAccumulator` (16 ms /
//      16 KiB cadence; the FOREVER-STABLE constants live in
//      `pty/segmentation.ts`) batches raw VT bytes from the future
//      node-pty `master.onData` event. Each emitted segment becomes a
//      `DeltaMessage` IPC with monotonic `seq` starting at 1n.
//
//      The pty-output entrypoint (`feedPtyOutput`) is internal-only
//      and is wired by the future T4.6 PtyWriter when it constructs the
//      `node-pty` master; until then there is simply no producer, so no
//      deltas flow but the cadence machinery is in place and unit-tested
//      via `snapshot-scheduler.spec.ts` plus the daemon-boot e2e
//      (end-to-end once T4.6 + T-PA-5 land).
//
//   3. Snapshot scheduler (ch06 §4) — `SnapshotScheduler` in
//      `./snapshot-scheduler.ts` is a callback-driven cadence engine:
//      it owns its own wall-clock window timer + Resize coalesce timer
//      (driven by injected `TimerOps`) and synchronously invokes the
//      `onSnapshot(reason)` sink whenever a trigger fires (delta-count,
//      byte-volume, time-window-with-deltas, or coalesced Resize).
//      Counters reset inside the scheduler before the sink runs, so
//      child.ts only emits the SnapshotMessage IPC and does not need to
//      drive `onSnapshotTaken`/timer logic. The sink flushes any
//      in-flight delta segment via `accumulator.flushNow()` first so
//      `baseSeq` reflects the most-recent emitted seq.
//
//   The cadence dispatch is per-session because this whole file IS
//   per-session — `child_process.fork` gives us one V8 isolate per
//   pty-host child. There is no cross-session state.
//
// What is intentionally NOT here yet:
//   - `node-pty` import / spawn — lands with T4.6 alongside the codec.
//   - `xterm-headless` import / Terminal init — lands with T4.6 (codec).
//   - Real node-pty PtyWriter implementation — T4.6+. The future writer
//     calls `feedPtyOutput(buf)` on every `master.onData` event so the
//     accumulator below sees real VT bytes.
//   - SnapshotV1 codec wrapping — T4.6. The synthetic + cadence
//     snapshots currently emit `screenState = new Uint8Array(0)`; once
//     the codec ships, swap in `encodeSnapshotV1(...)`.
//
// SRP: this module is a *sink* for host→child messages and a *producer*
// of child→host lifecycle / delta / snapshot messages. The
// pending-write decider lives in `pending-write-tracker.ts`; the
// segmentation decider lives in `pty/segmentation.ts`; the snapshot
// cadence decider lives in `snapshot-scheduler.ts`; the future node-pty
// writer lives behind the `PtyWriter` interface so this file stays the
// orchestrator only.
//
// Layer 1: this file only runs as a forked child. It has no exports
// other than the side-effect of installing IPC handlers; the host
// surface (`spawnPtyHostChild`) is what daemon code imports.

import { computeSpawnArgv } from './spawn-argv.js';
import {
  PendingWriteTracker,
  PENDING_WRITE_CAP_BYTES,
} from './pending-write-tracker.js';
import {
  TEST_CRASH_EXIT_CODE,
  TestCrashByteCounter,
  estimateIpcPayloadBytes,
  parseTestCrashEnv,
  type TestCrashConfig,
} from './test-crash-config.js';
import { DeltaAccumulator } from '../pty/segmentation.js';
import { SnapshotScheduler, type SnapshotReason } from './snapshot-scheduler.js';
import type {
  ChildToHostMessage,
  HostToChildMessage,
  SpawnPayload,
} from './types.js';

/**
 * Pluggable writer for `send-input` bytes that pass the backpressure
 * check. T4.3 ships with a stub `instantDrainWriter` which feeds drain
 * accounting back to the tracker synchronously (so the tracker tally
 * never grows under the stub — which is exactly the right behavior for
 * a no-op writer; the cap still rejects oversized SINGLE writes).
 *
 * T4.6+ replaces the default with a writer that calls
 * `ptyMaster.write(buf)` and registers a drain listener; that writer
 * MUST call `tracker.recordWrite(buf.length)` BEFORE handing bytes to
 * the master and MUST call `tracker.recordDrain(n)` from the drain
 * event with the drained byte count. The same T4.6 wiring also calls
 * `feedPtyOutput(buf)` on every `master.onData` event so the
 * `DeltaAccumulator` below sees real VT bytes.
 */
export interface PtyWriter {
  /** Write `bytes` to the underlying pty master. The implementation is
   *  responsible for calling `tracker.recordWrite` / `recordDrain` at
   *  the appropriate times. Throws or rejects if the underlying master
   *  is not writable; the caller maps that into a child crash exit. */
  write(bytes: Uint8Array): void;
}

function log(line: string): void {
  // Stdout (not IPC) so the daemon's stdout tail captures it. Prefix
  // includes the pid so multi-session logs stay attributable.
  process.stdout.write(`[ccsm-pty-host pid=${process.pid}] ${line}\n`);
}

function send(msg: ChildToHostMessage): void {
  // `process.send` exists only when forked with an IPC channel. We are
  // strict: if it is missing we abort — running this file directly
  // (without `child_process.fork`) is a programming error.
  if (typeof process.send !== 'function') {
    process.stderr.write(
      '[ccsm-pty-host] FATAL: no IPC channel; this entrypoint must be forked.\n',
    );
    process.exit(2);
  }
  process.send(msg);
  // T4.5: account for outgoing IPC bytes against the `after-bytes:N`
  // test-crash variant. The check runs AFTER the message is sent so
  // the host actually observes the payload that tipped the counter
  // (mirrors spec wording: "after the first 1024 bytes ... cross the
  // IPC boundary"). In production `testCrash` is null and this is a
  // single null-check + return.
  maybeTriggerTestCrashAfterBytes(msg);
}

function isHostToChildMessage(x: unknown): x is HostToChildMessage {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  if (k !== 'spawn' && k !== 'close' && k !== 'send-input' && k !== 'resize') {
    return false;
  }
  if (k === 'send-input') {
    // Defensive shape check — IPC delivers structured-clonable values
    // but a malformed parent could still send a wrong-typed `bytes`.
    const b = (x as { bytes?: unknown }).bytes;
    return b instanceof Uint8Array;
  }
  return true;
}

let spawnPayload: SpawnPayload | null = null;

// T4.3: per-child pending-write tracker. The cap is the spec's 1 MiB
// constant; tests that need a smaller cap fork with the env var
// `CCSM_PTY_PENDING_CAP_BYTES` (used only by the T4.3 fixture — NOT a
// production tuning knob; the cap is FOREVER-STABLE per spec).
const tracker = new PendingWriteTracker(resolveCapForTest());

// T4.3 default writer: instant-drain stub. T4.6+ replaces this when
// node-pty + xterm-headless are wired in.
const writer: PtyWriter = makeInstantDrainWriter(tracker);

// --- T-PA-8 child→host emission state ----------------------------------
//
// The accumulator and scheduler are constructed lazily on `spawn`
// because they need (a) the wall-clock anchor for the time-window
// trigger and (b) the current geometry for snapshot emission. Until
// `spawn` arrives, no deltas can flow (the future node-pty master is
// not yet created) so "lazy at spawn" is the natural lifecycle, not a
// workaround.

let accumulator: DeltaAccumulator | null = null;
let scheduler: SnapshotScheduler | null = null;
let currentGeometry: { cols: number; rows: number } | null = null;

function resolveCapForTest(): number {
  const raw = process.env.CCSM_PTY_PENDING_CAP_BYTES;
  if (raw === undefined || raw === '') return PENDING_WRITE_CAP_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return PENDING_WRITE_CAP_BYTES;
  return parsed;
}

function makeInstantDrainWriter(t: PendingWriteTracker): PtyWriter {
  return {
    write(bytes: Uint8Array): void {
      // Stub semantics: account for the write then immediately drain
      // the same byte count. A real node-pty writer will defer the
      // recordDrain call until the master's drain event fires.
      t.recordWrite(bytes.length);
      t.recordDrain(bytes.length);
    },
  };
}

// T4.5: test-only crash configuration. Parsed once at module load from
// `CCSM_PTY_TEST_CRASH_ON` + `NODE_ENV`; in production both checks
// short-circuit to `null` and every hook below becomes a single
// null-guard + return. The byte counter only mutates when the
// `after-bytes` variant is active.
const testCrash: TestCrashConfig | null = parseTestCrashEnv(
  process.env.CCSM_PTY_TEST_CRASH_ON,
  process.env.NODE_ENV,
);
const testCrashCounter = new TestCrashByteCounter();

/**
 * Crash the child with the spec-defined exit code. Logs a stable line
 * the integration test can grep before the process exits so failure
 * triage shows WHICH variant fired. Never returns (process.exit aborts
 * the event loop); declared as `never` so callers do not need to add
 * an unreachable `return`.
 */
function triggerTestCrash(reasonLine: string): never {
  log(
    `TEST-ONLY crash branch fired: variant=${testCrash?.kind ?? 'unknown'} ` +
    `event=${reasonLine} exitCode=${TEST_CRASH_EXIT_CODE}`,
  );
  // Best-effort structured pre-exit signal so the daemon's lifecycle
  // watcher can distinguish a test-crash from a wild crash in log
  // triage. The `exiting` message kind already enumerates `'test-crash'`
  // in types.ts (reserved by T4.1 in anticipation of this task). We
  // call `process.send` directly (not `send(...)`) so the after-bytes
  // accounting hook does NOT recurse into another crash check on the
  // notification message itself.
  if (typeof process.send === 'function') {
    try {
      process.send({ kind: 'exiting', reason: 'test-crash' });
    } catch {
      // Parent may have already disconnected; ignore — the exit
      // code below is the source of truth.
    }
  }
  process.exit(TEST_CRASH_EXIT_CODE);
}

/**
 * After-bytes accounting hook. Called from `send` after every child→
 * host IPC message. Production no-op (testCrash null OR variant !=
 * after-bytes); under the variant it accumulates the estimated payload
 * byte count and fires `triggerTestCrash` the moment the threshold is
 * reached.
 */
function maybeTriggerTestCrashAfterBytes(msg: ChildToHostMessage): void {
  if (testCrash === null || testCrash.kind !== 'after-bytes') return;
  const bytes = estimateIpcPayloadBytes(msg);
  if (testCrashCounter.addAndShouldCrash(bytes, testCrash.threshold)) {
    triggerTestCrash(
      `after-bytes:${testCrash.threshold} (cumulative=${testCrashCounter.cumulative})`,
    );
  }
}

/**
 * Emit a SnapshotMessage IPC for the current session. Spec
 * `2026-05-04-pty-attach-handler.md` §2.2 + design ch06 §4.
 *
 * `baseSeq` is computed as the seq of the most-recent emitted delta —
 * which the accumulator exposes as `nextSeqWillEmit() - 1` AFTER a
 * `flushNow()` call has drained any in-flight bytes. For the synthetic
 * initial snapshot (called from `handleSpawn` before any deltas have
 * been emitted), the caller passes `baseSeq=0n` directly.
 *
 * `screenState` is currently a stub `Uint8Array(0)`; T4.6 swaps in
 * `encodeSnapshotV1(xterm.serialize())` once the codec lands. The IPC
 * shape (`Uint8Array`) does not change.
 */
function emitSnapshot(
  baseSeq: bigint,
  geometry: { cols: number; rows: number },
): void {
  send({
    kind: 'snapshot',
    baseSeq,
    geometry: { cols: geometry.cols, rows: geometry.rows },
    // Stub: empty screen bytes. T4.6 (SnapshotV1 codec + xterm-headless)
    // replaces this with the encoded screen state. The Attach handler
    // (T-PA-5) treats `screenState` as opaque, so the swap is local to
    // this file.
    screenState: new Uint8Array(0),
    schemaVersion: 1,
  });
}

/**
 * Sink invoked by the `SnapshotScheduler` whenever a trigger fires.
 * Drains any in-flight delta bytes first so the snapshot's `baseSeq`
 * reflects the most-recent emitted delta — the load-bearing invariant
 * for `since_seq` resume math (spec §3.4). The scheduler has already
 * reset its counters before calling us, so we do not need to drive any
 * scheduler bookkeeping here.
 */
function onSchedulerSnapshot(reason: SnapshotReason): void {
  if (accumulator === null || currentGeometry === null) {
    // Defensive: a trigger arrived before `spawn` initialized state.
    // The scheduler is constructed in `handleSpawn` so this branch is
    // unreachable in correct callers; we log and bail rather than
    // emit a malformed snapshot.
    log(`(bug) cadence snapshot trigger=${reason} before spawn; ignored`);
    return;
  }
  accumulator.flushNow();
  // After flushNow, `nextSeqWillEmit() - 1` is the seq of the most
  // recent emitted delta (or `firstSeq - 1 = 0` if no deltas yet).
  const lastSeq = accumulator.nextSeqWillEmit() - 1;
  emitSnapshot(BigInt(lastSeq), currentGeometry);
  log(`snapshot emitted: reason=${reason} baseSeq=${lastSeq}`);
}

/**
 * Internal entry point invoked by the future T4.6 node-pty wiring on
 * every `master.onData(buf)` event. NOT exported — T4.6 lives in this
 * same file when it lands. The function is module-local so external
 * tests cannot bypass the IPC boundary by calling it directly.
 *
 * Currently UNCALLED: the T4.3 stub `instantDrainWriter` does not
 * spawn `node-pty`, so no PTY output exists. The plumbing is in place
 * so the moment T4.6 wires `master.onData(b => feedPtyOutput(b))`,
 * deltas start flowing at the 16 ms / 16 KiB cadence and the scheduler
 * starts firing time/delta/byte/resize-triggered snapshots.
 */
function feedPtyOutput(bytes: Uint8Array): void {
  if (accumulator === null) {
    // Bytes before spawn would mean node-pty produced output before we
    // told it the geometry — a wiring bug. Drop with a log line; the
    // future T4.6 unit tests will cover the legal ordering.
    log(`(bug) PTY output ${bytes.length} bytes before spawn; dropped`);
    return;
  }
  accumulator.push(bytes);
}
// Reference the symbol so `noUnusedLocals` does not flag it before T4.6
// wires `master.onData(feedPtyOutput)`. Removing this line is a no-op
// once the real node-pty integration lands.
void feedPtyOutput;

function handleSpawn(payload: SpawnPayload): void {
  if (spawnPayload !== null) {
    log(`ignoring duplicate spawn for session ${payload.sessionId}`);
    return;
  }
  spawnPayload = payload;
  // T4.5: spawn-event test crash. Models "node-pty.spawn threw" without
  // depending on the unfinished T4.6 wiring. Production no-op.
  if (testCrash !== null && testCrash.kind === 'spawn') {
    triggerTestCrash(`spawn (session=${payload.sessionId})`);
  }
  // T4.2: compute the per-OS spawn argv (Windows wraps in
  // `cmd /c chcp 65001 >nul && claude.exe ...`; POSIX is bare claude).
  // We log the resolved (file, args) so installer smoke + the soak
  // harness can grep for the exact command line that *will* be spawned.
  // The actual `node-pty.spawn(file, args)` call lands in T4.6+.
  const resolved = computeSpawnArgv({
    platform: process.platform,
    claudeArgs: payload.claudeArgs,
  });
  log(
    `spawn accepted: session=${payload.sessionId} cols=${payload.cols} ` +
    `rows=${payload.rows} argv=${JSON.stringify(payload.claudeArgs)} ` +
    `resolved.file=${JSON.stringify(resolved.file)} ` +
    `resolved.args=${JSON.stringify(resolved.args)}`,
  );

  // T-PA-8: initialize delta accumulator + snapshot scheduler.
  currentGeometry = { cols: payload.cols, rows: payload.rows };
  accumulator = new DeltaAccumulator({
    onDelta: ({ seq, payload: bytes, tsMs }) => {
      // Forward the segment as IPC. Native `Uint8Array` survives
      // structured clone (`serialization: 'advanced'` on the IPC
      // channel) without base64 cost — see types.ts §DeltaMessage.
      send({
        kind: 'delta',
        seq: BigInt(seq),
        tsUnixMs: BigInt(tsMs),
        payload: bytes,
      });
      // Account the byte volume against the snapshot scheduler. The
      // callback-driven scheduler will synchronously invoke
      // `onSchedulerSnapshot` if any threshold trips, so no return
      // value to inspect here.
      if (scheduler !== null) {
        scheduler.noteDelta(bytes.length);
      }
    },
    now: Date.now,
    timer: {
      setTimer: (cb, delayMs) => setTimeout(cb, delayMs),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    },
    // firstSeq defaults to 1 — the synthetic snapshot's baseSeq=0
    // anchors the seq sequence so the first real delta is seq=1.
  });
  scheduler = new SnapshotScheduler({
    onSnapshot: onSchedulerSnapshot,
    now: Date.now,
    timer: {
      setTimer: (cb, delayMs) => setTimeout(cb, delayMs),
      clearTimer: (h) => clearTimeout(h as NodeJS.Timeout),
    },
  });

  // §3.3 FOREVER-STABLE: emit synthetic initial snapshot (baseSeq=0n)
  // BEFORE accepting / streaming any deltas. The scheduler is already
  // constructed so a delta arriving in the same tick (extremely
  // unlikely with the future node-pty since spawn() is synchronous
  // before onData fires, but defensive) will see the correct anchor.
  // This snapshot is emitted DIRECTLY (not via the scheduler) — the
  // scheduler's wall-clock baseline is set at construction (just
  // above) and represents "session start", which is exactly when the
  // synthetic snapshot is taken.
  emitSnapshot(0n, currentGeometry);
  log(`synthetic snapshot emitted: baseSeq=0 cols=${payload.cols} rows=${payload.rows}`);
}

function handleClose(): void {
  log('close requested; sending exiting notice and exiting 0');
  // T-PA-8: tear down cadence machinery before exit. We do NOT flush
  // the accumulator here — buffered bytes that have not yet been
  // emitted as a delta would carry a seq the daemon-side coalescer has
  // not seen, and the snapshot scheduler is already torn down so a
  // late snapshot cannot anchor them. Subscriber-side recovery is
  // covered by the SQLite snapshot history (ch06 §7 restart replay).
  if (accumulator !== null) {
    accumulator.dispose();
    accumulator = null;
  }
  if (scheduler !== null) {
    scheduler.dispose();
    scheduler = null;
  }
  currentGeometry = null;

  send({ kind: 'exiting', reason: 'graceful' });
  // Defer exit so the IPC 'message' actually lands at the parent
  // before the 'exit' event fires. Calling `process.disconnect()`
  // here can reorder the two on some Node builds; the natural IPC
  // drain via a small setTimeout is more portable.
  setTimeout(() => process.exit(0), 20);
}

function handleSendInput(bytes: Uint8Array): void {
  // T4.3: per-session 1 MiB pending-write cap (spec ch06 §1 F5).
  // We require a prior `spawn` so the child is fully initialized before
  // accepting traffic. A stray `send-input` before spawn is a daemon-side
  // ordering bug; we drop with a log line rather than crash.
  if (spawnPayload === null) {
    log(`(early) send-input bytes=${bytes.length} dropped before spawn`);
    return;
  }
  const verdict = tracker.decide(bytes.length);
  if (verdict.kind === 'reject') {
    log(
      `send-input rejected: pending=${verdict.pendingWriteBytes} ` +
      `attempted=${verdict.attemptedBytes} cap=${verdict.capBytes}`,
    );
    // Flat IPC shape per spec 2026-05-04-pty-attach-handler.md §2.2.
    // The daemon main process knows which session this child owns via
    // the PtyHostChildHandle that wraps its IPC channel; sessionId is
    // intentionally NOT echoed back.
    send({
      kind: 'send-input-rejected',
      pendingWriteBytes: verdict.pendingWriteBytes,
      attemptedBytes: verdict.attemptedBytes,
    });
    return;
  }
  // Accepted: forward to the writer. The writer is responsible for
  // calling `tracker.recordWrite` / `recordDrain`.
  writer.write(bytes);
}

function handleResize(cols: number, rows: number): void {
  // T-PA-8: update the cached geometry so the next emitted snapshot
  // (whether cadence-driven or resize-triggered) carries the correct
  // dimensions. The future T4.6 wiring also calls
  // `master.resize(cols, rows)` and `xterm.resize(cols, rows)` here.
  if (currentGeometry !== null) {
    currentGeometry.cols = cols;
    currentGeometry.rows = rows;
  }
  log(`(stub) resize cols=${cols} rows=${rows}`);
  // Resize-snapshot coalescing (ch06 §4 FOREVER-STABLE): the scheduler
  // owns the 500ms coalesce window internally; subsequent Resizes
  // inside that window are no-ops. The scheduler will fire its
  // `onSnapshot` sink when the window closes.
  if (scheduler !== null) {
    scheduler.noteResize();
  }
}

function handleMessage(raw: unknown): void {
  if (!isHostToChildMessage(raw)) {
    log(`dropped malformed IPC message: ${JSON.stringify(raw)}`);
    return;
  }
  switch (raw.kind) {
    case 'spawn':
      handleSpawn(raw.payload);
      return;
    case 'close':
      handleClose();
      return;
    case 'send-input':
      handleSendInput(raw.bytes);
      return;
    case 'resize':
      handleResize(raw.cols, raw.rows);
      return;
  }
}

// --- Boot ----------------------------------------------------------------

process.on('message', handleMessage);

// If the parent disconnects without sending `close`, exit nonzero so the
// daemon's `child.on('exit')` flips the session to CRASHED per ch06 §1
// (the v0.3 crash semantics treat any non-`close`-initiated exit as a
// crash). This is also the safety net for an Electron-quit edge case.
process.on('disconnect', () => {
  log('IPC parent disconnected without close; exiting 1');
  process.exit(1);
});

// Tell the parent we are ready. The parent's `ready()` promise resolves
// off this message; until then it cannot send `spawn`. The pid travels
// with the message so the parent can log/store it before observing it
// via the ChildProcess handle (eliminates a TOCTOU window where pid
// could be needed before fork() returns it).
send({ kind: 'ready', sessionId: '', pid: process.pid });

log('ready');

// T4.5: boot-event test crash. Fired AFTER `ready` is sent so the
// daemon's lifecycle watcher observes the same handshake sequence as
// a real child that crashed immediately post-init (more realistic than
// crashing before `ready`, which would test a different code path —
// the "child never readied" timeout in T4.6+ host wiring). Production
// no-op (testCrash null).
if (testCrash !== null && testCrash.kind === 'boot') {
  triggerTestCrash('boot');
}
