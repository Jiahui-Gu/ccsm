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
// What is intentionally NOT here yet:
//   - `node-pty` import / spawn — lands with T4.6 alongside the codec.
//   - `xterm-headless` import / Terminal init — lands with T4.6 (codec).
//   - Delta accumulator + snapshot scheduler — T4.9 / T4.10.
//   - Real node-pty PtyWriter implementation — T4.6+.
//
// SRP: this module is a *sink* for host→child messages and a *producer*
// of child→host lifecycle messages. The pending-write decider lives in
// `pending-write-tracker.ts`; the future node-pty writer lives behind
// the `PtyWriter` interface so this file stays the orchestrator only.
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
 * event with the drained byte count.
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
}

function handleClose(): void {
  log('close requested; sending exiting notice and exiting 0');
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
      // T4.10 wires xterm-headless resize + Resize-snapshot coalescing.
      log(`(stub) resize cols=${raw.cols} rows=${raw.rows}`);
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
