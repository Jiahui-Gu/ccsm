#!/usr/bin/env node
// client.mjs — single-shot UDS connect probe.
//
// Spike T9.2 (spec ch14 §1.2 phase 0.5): connect() to a UDS path, send one
// line, read the echo, classify the outcome. Designed to be invoked under
// `sudo -u <other-user>` so the probe driver can quantify cross-user
// reachability with and without TCC/FDA grants.
//
// Forever-stable contract:
//
//   Usage:
//     client.mjs --socket=<path> [--timeout-ms=<n>] [--message=<str>]
//
//   Output (stdout, single trailing JSON line):
//     {"socket":<path>,"euid":<int>,"egid":<int>,
//      "outcome":"OK"|"EACCES"|"EPERM"|"ENOENT"|"ECONNREFUSED"|"ETIMEDOUT"|"OTHER",
//      "errno":<str|null>,"message":<str|null>,
//      "rttMs":<int|null>,"reply":<str|null>}
//
//   Exit codes:
//     0 OK (echo round-trip succeeded)
//     3 connect/read failure (any non-OK outcome — still emits JSON)
//     2 bad arg or unsupported OS
//
//   The driver script (run.sh) classifies EPERM as the TCC/FDA signal on
//   darwin (kernel returns EPERM when sandbox/TCC blocks UDS connect under
//   protected paths like ~/Library/...). EACCES is the POSIX-perm signal.
//
// Layer-1: node: stdlib only.

import { connect } from 'node:net';
import { parseArgs } from 'node:util';
import { platform } from 'node:os';

if (platform() === 'win32') {
  process.stderr.write('macos-uds-cross-user client: win32 unsupported\n');
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    socket:       { type: 'string' },
    'timeout-ms': { type: 'string', default: '3000' },
    message:      { type: 'string', default: 'hello' },
  },
  strict: true,
});

if (!values.socket) {
  process.stderr.write('--socket=<path> required\n');
  process.exit(2);
}

const socketPath = values.socket;
const timeoutMs = Number(values['timeout-ms']);
if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
  process.stderr.write('bad --timeout-ms\n');
  process.exit(2);
}
const message = values.message;

const euid = typeof process.geteuid === 'function' ? process.geteuid() : -1;
const egid = typeof process.getegid === 'function' ? process.getegid() : -1;

function classify(err) {
  if (!err) return 'OK';
  switch (err.code) {
    case 'EACCES':        return 'EACCES';
    case 'EPERM':         return 'EPERM';
    case 'ENOENT':        return 'ENOENT';
    case 'ECONNREFUSED':  return 'ECONNREFUSED';
    case 'ETIMEDOUT':     return 'ETIMEDOUT';
    default:              return 'OTHER';
  }
}

function emit(outcome, err, rttMs, reply) {
  const line = JSON.stringify({
    socket: socketPath,
    euid,
    egid,
    outcome,
    errno: err ? (err.code ?? null) : null,
    message: err ? (err.message ?? null) : null,
    rttMs,
    reply,
  });
  process.stdout.write(line + '\n');
  process.exit(outcome === 'OK' ? 0 : 3);
}

const start = process.hrtime.bigint();
const sock = connect(socketPath);
let settled = false;
let buf = '';

const timer = setTimeout(() => {
  if (settled) return;
  settled = true;
  try { sock.destroy(); } catch { /* ignore */ }
  emit('ETIMEDOUT', { code: 'ETIMEDOUT', message: `no reply within ${timeoutMs}ms` }, null, null);
}, timeoutMs);

sock.setEncoding('utf8');
sock.on('connect', () => {
  sock.write(`${message}\n`);
});
sock.on('data', (chunk) => { buf += chunk; });
sock.on('end', () => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  const rttMs = Number((process.hrtime.bigint() - start) / 1_000_000n);
  if (buf.startsWith(`ack:`)) {
    emit('OK', null, rttMs, buf.trimEnd());
  } else {
    emit('OTHER', { code: 'EPROTO', message: `unexpected reply: ${JSON.stringify(buf)}` }, rttMs, buf);
  }
});
sock.on('error', (err) => {
  if (settled) return;
  settled = true;
  clearTimeout(timer);
  emit(classify(err), err, null, null);
});
