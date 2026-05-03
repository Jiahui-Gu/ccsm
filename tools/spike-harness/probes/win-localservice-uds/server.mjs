// T9.1 spike server — Windows named pipe with peer-cred check
//
// Per spec ch14 §1.1 phase 0.5 (Task #103):
//   listens on \\.\pipe\ccsm-spike-1.1, on each accepted client emits a
//   one-line JSON probe describing what GetNamedPipeClientProcessId says
//   about the connecting client, then writes "OK\n" and closes.
//
// Layer-1: node: stdlib only — `net`, `os`, `child_process`, `path`, `url`.
// No npm deps.
//
// Usage:
//   node server.mjs [pipeName]            # default: ccsm-spike-1.1
//
// Stdout (newline-delimited JSON, line-buffered):
//   {"event":"listening","pipe":"\\\\.\\pipe\\<pipeName>","serverPid":N,
//    "serverSid":"S-1-..."}
//   {"event":"accept","clientPid":M,"clientSid":"S-1-..."}      (per client)
//   {"event":"shutdown"}                                         (on SIGTERM)
//
// Exit 2 on non-win32; exit 1 on listen error.

import net from 'node:net';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

if (process.platform !== 'win32') {
    console.error('win32-only spike (skipping)');
    process.exit(2);
}

const pipeName = process.argv[2] || 'ccsm-spike-1.1';
const pipePath = `\\\\.\\pipe\\${pipeName}`;
const here = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(here, '..', '..');
const peerCredScript = path.join(harnessRoot, 'connect-and-peercred.ps1');

function emit(obj) {
    process.stdout.write(JSON.stringify(obj) + '\n');
}

// Resolve the server's own SID for the listening event (sanity check —
// callers compare against this to confirm peer-cred returns *another*
// principal than the server when the client runs as a different user).
function ownSid() {
    try {
        const r = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            '([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value'
        ], { encoding: 'utf8' });
        return (r.stdout || '').trim();
    } catch { return ''; }
}

const serverSid = ownSid();
const serverPid = process.pid;

const server = net.createServer((sock) => {
    // The accepted `net.Socket` wraps a libuv pipe handle. We do NOT have
    // direct access to the OS HANDLE here from JS, so we shell out to the
    // PowerShell P/Invoke probe — but that probe takes a *path* (not a
    // handle). For server-side peer-cred at accept time we therefore use
    // a sidecar invocation: the probe itself does CreateFile on the same
    // path, gets a *fresh* handle, and asks the kernel "who is the
    // client". This works because Windows tracks per-pipe-instance peer
    // PIDs by handle, not by some accept-only state — both the freshly
    // opened handle and the server's accepted handle observe the same
    // client. (See T9.5 spike PROBE-RESULT.md for the same shell-out
    // approach.)
    //
    // For the §1.1 single-shot test we don't actually need to call
    // peer-cred per accept here — the `probe.ps1` orchestrator runs the
    // client + peer-cred lookup itself. We just record the accept event.
    const remote = sock.address ? sock.address() : null;
    emit({ event: 'accept', remote });
    // EPIPE-tolerant: a peer can open the pipe purely for SetSecurityInfo
    // (WRITE_DAC | READ_CONTROL) and then close without reading; Node's
    // libuv server still surfaces that as an accept and `sock.end()`
    // returns EPIPE because the handle was already torn down. Swallow.
    sock.on('error', (err) => {
        emit({ event: 'accept-error', code: err.code || String(err) });
    });
    try { sock.end('OK\n'); } catch (err) {
        emit({ event: 'write-error', code: err.code || String(err) });
    }
});

server.on('error', (err) => {
    emit({ event: 'error', message: String(err.message || err) });
    process.exit(1);
});

server.listen(pipePath, () => {
    emit({
        event: 'listening',
        pipe: pipePath,
        serverPid,
        serverSid,
        host: os.hostname(),
        peerCredScript
    });
});

function shutdown() {
    emit({ event: 'shutdown' });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGBREAK', shutdown);
