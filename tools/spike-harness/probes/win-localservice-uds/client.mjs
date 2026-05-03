// T9.1 spike client — connect to \\.\pipe\ccsm-spike-1.1, read response.
//
// Layer-1: node: stdlib only.
//
// Usage: node client.mjs [pipeName]
//
// Stdout (one JSON line):
//   {"connected":true,"received":"OK","ms":N,"clientPid":N,"clientSid":"S-..."}
//
// Exit 0 on success ("OK" received), 1 on connect/IO error, 2 on non-win32.

import net from 'node:net';
import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
    console.error('win32-only spike (skipping)');
    process.exit(2);
}

const pipeName = process.argv[2] || 'ccsm-spike-1.1';
const pipePath = `\\\\.\\pipe\\${pipeName}`;

function ownSid() {
    try {
        const r = spawnSync('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            '([Security.Principal.WindowsIdentity]::GetCurrent()).User.Value'
        ], { encoding: 'utf8' });
        return (r.stdout || '').trim();
    } catch { return ''; }
}

const start = Date.now();
const sock = net.connect(pipePath);
let buf = '';
let done = false;

sock.setEncoding('utf8');
sock.on('data', (d) => { buf += d; });
sock.on('error', (err) => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify({
        connected: false, error: String(err.message || err), pipe: pipePath
    }) + '\n');
    process.exit(1);
});
sock.on('end', () => {
    if (done) return;
    done = true;
    const ms = Date.now() - start;
    const ok = buf.startsWith('OK');
    process.stdout.write(JSON.stringify({
        connected: true,
        received: buf.replace(/\s+$/, ''),
        ms,
        clientPid: process.pid,
        clientSid: ownSid(),
        pipe: pipePath
    }) + '\n');
    process.exit(ok ? 0 : 1);
});

setTimeout(() => {
    if (done) return;
    done = true;
    process.stdout.write(JSON.stringify({
        connected: false, error: 'timeout', pipe: pipePath
    }) + '\n');
    process.exit(1);
}, 5000).unref();
