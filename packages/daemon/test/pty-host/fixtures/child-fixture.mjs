// Test fixture: a minimal pty-host child stand-in. Mirrors the IPC
// protocol of `src/pty-host/child.ts` (spawn → ready → close → exit 0)
// but does not depend on any TS imports — this is pure ESM JS so it can
// be `child_process.fork`'d directly under vitest without a build step.
//
// The fixture supports a few env-driven behaviors so the host.spec.ts
// can exercise the lifecycle paths:
//
//   CCSM_FIXTURE_MODE=normal    (default) — ready, accept close, exit 0
//   CCSM_FIXTURE_MODE=crash     — ready then process.exit(137) immediately
//   CCSM_FIXTURE_MODE=no-ready  — never send ready (parent ready() should reject on exit)
//   CCSM_FIXTURE_MODE=echo      — echo every spawn payload back as a 'snapshot' kind

const mode = process.env.CCSM_FIXTURE_MODE ?? 'normal';

function send(msg) {
  if (typeof process.send !== 'function') {
    process.stderr.write('[fixture] no IPC; aborting\n');
    process.exit(2);
  }
  process.send(msg);
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
