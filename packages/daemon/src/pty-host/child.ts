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
// What is intentionally NOT here yet:
//   - `node-pty` import / spawn — lands with T4.6 alongside the codec.
//   - `xterm-headless` import / Terminal init — lands with T4.6 (codec).
//   - Delta accumulator + snapshot scheduler — T4.9 / T4.10.
//   - 1 MiB SendInput backpressure — T4.3.
//   - Test-only crash branch (`CCSM_PTY_TEST_CRASH_ON`) — T4.5.
//
// SRP: this module is a *sink* for host→child messages and a *producer*
// of child→host lifecycle messages. Real PTY I/O is delegated to future
// modules (one node-pty wrapper per concern; not all in this file).
//
// Layer 1: this file only runs as a forked child. It has no exports
// other than the side-effect of installing IPC handlers; the host
// surface (`spawnPtyHostChild`) is what daemon code imports.

import { computeSpawnArgv } from './spawn-argv.js';
import type {
  ChildToHostMessage,
  HostToChildMessage,
  SpawnPayload,
} from './types.js';

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
}

function isHostToChildMessage(x: unknown): x is HostToChildMessage {
  if (typeof x !== 'object' || x === null) return false;
  const k = (x as { kind?: unknown }).kind;
  return k === 'spawn' || k === 'close' || k === 'send-input' || k === 'resize';
}

let spawnPayload: SpawnPayload | null = null;

function handleSpawn(payload: SpawnPayload): void {
  if (spawnPayload !== null) {
    log(`ignoring duplicate spawn for session ${payload.sessionId}`);
    return;
  }
  spawnPayload = payload;
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
      // T4.3 wires the backpressure cap + master.write here.
      log(`(stub) send-input bytes=${raw.bytes.length}`);
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
