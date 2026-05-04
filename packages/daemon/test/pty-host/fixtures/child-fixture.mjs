/* global process, setTimeout, setImmediate */
// Test fixture: a minimal pty-host child stand-in. Mirrors the IPC
// protocol of `src/pty-host/child.ts` (spawn → ready → close → exit 0)
// but does not depend on any TS imports — this is pure ESM JS so it can
// be `child_process.fork`'d directly under vitest without a build step.
//
// The fixture supports a few env-driven behaviors so the host.spec.ts
// can exercise the lifecycle paths:
//
//   CCSM_FIXTURE_MODE=normal         (default) — ready, accept close, exit 0
//   CCSM_FIXTURE_MODE=crash          — ready then process.exit(137) immediately
//   CCSM_FIXTURE_MODE=no-ready       — never send ready (parent ready() should reject on exit)
//   CCSM_FIXTURE_MODE=echo           — echo every spawn payload back as a 'snapshot' kind
//   CCSM_FIXTURE_MODE=backpressure   — T4.3: enforce a small pending-write cap
//                                       (CCSM_PTY_PENDING_CAP_BYTES) and emit
//                                       'send-input-rejected' IPC matching the
//                                       real child.ts shape. Stub writer is
//                                       instant-drain (matches T4.3 default).

const mode = process.env.CCSM_FIXTURE_MODE ?? 'normal';
const capBytes = (() => {
  const raw = process.env.CCSM_PTY_PENDING_CAP_BYTES;
  if (!raw) return 1024 * 1024;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 1024 * 1024;
})();

let pendingWriteBytes = 0;

function send(msg) {
  if (typeof process.send !== 'function') {
    process.stderr.write('[fixture] no IPC; aborting\n');
    process.exit(2);
  }
  process.send(msg);
}

function handleSendInput(bytes) {
  if (mode !== 'backpressure') return; // other modes ignore send-input
  const attempted = bytes.length;
  if (pendingWriteBytes + attempted > capBytes) {
    // Flat IPC shape per spec 2026-05-04-pty-attach-handler.md §2.2 —
    // mirrors src/pty-host/child.ts's send() call.
    send({
      kind: 'send-input-rejected',
      pendingWriteBytes,
      attemptedBytes: attempted,
    });
    return;
  }
  // Stub writer: account + instant drain (mirrors T4.3 default in
  // src/pty-host/child.ts).
  pendingWriteBytes += attempted;
  pendingWriteBytes = Math.max(0, pendingWriteBytes - attempted);
}

process.on('message', (raw) => {
  if (!raw || typeof raw !== 'object') return;
  const k = raw.kind;
  if (k === 'spawn') {
    if (mode === 'echo') {
      send({ kind: 'snapshot' });
    }
    return;
  }
  if (k === 'send-input') {
    if (raw.bytes instanceof Uint8Array) {
      handleSendInput(raw.bytes);
    }
    return;
  }
  if (k === 'close') {
    send({ kind: 'exiting', reason: 'graceful' });
    // Defer exit so the IPC 'message' lands at the parent before 'exit'.
    // (Calling process.disconnect() here can reorder them on some Node
    // builds; relying on the natural drain is more portable.)
    setTimeout(() => process.exit(0), 20);
    return;
  }
});

process.on('disconnect', () => {
  process.exit(1);
});

if (mode === 'no-ready') {
  // Stay alive briefly then exit nonzero so the parent ready() promise
  // gets a chance to reject via the exit-before-ready code path.
  setTimeout(() => process.exit(3), 50);
} else {
  send({ kind: 'ready', sessionId: '', pid: process.pid });
  if (mode === 'crash') {
    // Crash immediately after ready.
    setImmediate(() => process.exit(137));
  }
}
