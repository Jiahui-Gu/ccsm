#!/usr/bin/env node
// ccsm-uninstall-helper — NSIS uninstall pre-step (Task #1009 / T53).
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md §11.6.4
//     "Daemon-shutdown RPC integration (cross-ref frag-6-7)" — invoked by
//     NSIS customUnInstall as `"$TEMP\\ccsm-uninstall-helper.exe" --shutdown
//     --timeout 2000` BEFORE the main uninstall payload deletes files.
//   - frag-6-7 §6.4 + daemon/src/handlers/daemon-shutdown-for-upgrade.ts —
//     the daemon's `daemon.shutdownForUpgrade` RPC writes the clean-shutdown
//     marker, runs the §6.6.1 drain sequence, releases the lock, exit(0).
//   - daemon/src/sockets/control-socket.ts — Windows pipe namespace
//     `\\.\pipe\ccsm-control-<userhash>` where `<userhash>` = first 8 hex
//     chars of SHA-256(`<username>@<hostname>`). Same derivation as T14;
//     replicated locally so the helper has zero runtime deps.
//   - daemon/src/envelope/envelope.ts — wire frame format
//     `[totalLen:4][headerLen:2][headerJSON:headerLen][payload]`. Control-
//     plane RPCs (`SUPERVISOR_RPCS`, frag-3.4.1 §3.4.1.h) are EXEMPT from
//     the HMAC handshake / hello gate, so the helper can speak the wire
//     directly without `daemon.secret`.
//
// Single Responsibility:
//   PRODUCER: parses CLI args, derives pipe path.
//   DECIDER:  decides graceful (RPC reachable) vs hardstop (TerminateProcess).
//   SINK:     opens the named pipe, writes the frame, OR enumerates ccsm
//             processes via `tasklist` + kills via `taskkill /F`.
//
// Exit semantics (spec §11.6.4 + task brief):
//   0 — graceful shutdown OR daemon already dead (idempotent).
//   1 — hard error (couldn't kill processes that needed killing).
//
// Logging: best-effort to %TEMP%\ccsm-uninstall.log (single line per run).
//
// Bundled into a single .exe via @yao-pkg/pkg (target node22-win-x64).

'use strict';

const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const args = { shutdown: false, timeoutMs: 2000, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--shutdown') args.shutdown = true;
    else if (a === '--timeout') {
      const v = argv[++i];
      const n = Number.parseInt(v, 10);
      if (Number.isFinite(n) && n > 0) args.timeoutMs = n;
    } else if (a === '--help' || a === '-h') {
      args.help = true;
    }
  }
  return args;
}

const HELP = `ccsm-uninstall-helper — NSIS uninstall pre-step

Usage:
  ccsm-uninstall-helper --shutdown [--timeout MS]

Options:
  --shutdown      Send daemon.shutdownForUpgrade over the control-socket pipe.
                  Falls back to TerminateProcess on the daemon executable.
  --timeout MS    Timeout for the graceful RPC ack (default: 2000).
  --help, -h      Show this help.

Exit codes:
  0  graceful shutdown OR daemon already gone (idempotent)
  1  hard error (couldn't kill orphan processes)
`;

// ---------------------------------------------------------------------------
// Pipe path derivation (mirrors daemon/src/sockets/control-socket.ts)
// ---------------------------------------------------------------------------

function controlPipePath() {
  const username = (os.userInfo().username || process.env.USERNAME || 'unknown');
  const host = os.hostname();
  const tag = `${username}@${host}`;
  const userhash = crypto.createHash('sha256').update(tag).digest('hex').slice(0, 8);
  return `\\\\.\\pipe\\ccsm-control-${userhash}`;
}

// ---------------------------------------------------------------------------
// Logging — best-effort, single line, never throws
// ---------------------------------------------------------------------------

function logLine(msg) {
  try {
    const tmp = process.env.TEMP || process.env.TMP || os.tmpdir();
    const logPath = path.join(tmp, 'ccsm-uninstall.log');
    const ts = new Date().toISOString();
    fs.appendFileSync(logPath, `[${ts}] ${msg}\n`, { encoding: 'utf8' });
  } catch {
    // best-effort; uninstall must never fail because we couldn't log.
  }
}

// ---------------------------------------------------------------------------
// Envelope encode (mirrors daemon/src/envelope/envelope.ts encodeFrame for
// JSON-only frames; v0.3 nibble = 0x0; payloadLen low 28 bits)
// ---------------------------------------------------------------------------

function encodeJsonFrame(headerObj) {
  const headerJson = Buffer.from(JSON.stringify(headerObj), 'utf8');
  const headerLen = headerJson.length;
  // payloadLen = 2 (headerLen field) + headerLen + 0 (no trailer)
  const payloadLen = 2 + headerLen;
  // version nibble 0x0 in high 4 bits
  const raw = (0 << 28) | (payloadLen & 0x0fffffff);
  const out = Buffer.allocUnsafe(4 + payloadLen);
  out.writeUInt32BE(raw >>> 0, 0);
  out.writeUInt16BE(headerLen, 4);
  headerJson.copy(out, 6);
  return out;
}

// ---------------------------------------------------------------------------
// Graceful path: connect to the pipe, send daemon.shutdownForUpgrade, wait
// for either an ack frame OR the daemon to close the pipe (it exits after
// the shutdown sequence).
// ---------------------------------------------------------------------------

function gracefulShutdown(pipePath, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { sock.destroy(); } catch { /* noop */ }
      clearTimeout(timer);
      resolve(result);
    };

    const sock = net.createConnection(pipePath);

    const timer = setTimeout(() => {
      logLine(`graceful: timeout after ${timeoutMs}ms`);
      finish({ ok: false, reason: 'timeout' });
    }, timeoutMs);

    sock.once('error', (err) => {
      // ENOENT / EPIPE / ECONNREFUSED — daemon not running. Idempotent OK.
      logLine(`graceful: pipe error ${err && err.code ? err.code : err}`);
      finish({ ok: false, reason: 'unreachable', code: err && err.code });
    });

    sock.once('connect', () => {
      // Build the request frame. Header schema mirrors daemon/src/envelope
      // tests: { id, method, payloadType, payloadLen }. Method is the bare
      // SUPERVISOR_RPC name (no "ccsm.v1/" prefix; cf. dispatcher.ts).
      const header = {
        id: 1,
        method: 'daemon.shutdownForUpgrade',
        payloadType: 'json',
        payloadLen: 0,
      };
      try {
        const frame = encodeJsonFrame(header);
        sock.write(frame);
      } catch (err) {
        logLine(`graceful: encode error ${err && err.message}`);
        finish({ ok: false, reason: 'encode_error' });
        return;
      }
    });

    // Either we receive an ack (any data) or the daemon closes the pipe
    // after exit(0). Both are "graceful succeeded" outcomes per spec.
    sock.once('data', () => {
      logLine('graceful: ack received');
      // Give the daemon a moment to run its drain sequence + exit(0).
      setTimeout(() => finish({ ok: true, reason: 'ack' }), 250);
    });

    sock.once('end', () => {
      logLine('graceful: pipe closed by daemon');
      finish({ ok: true, reason: 'pipe_closed' });
    });
  });
}

// ---------------------------------------------------------------------------
// Hard fallback: enumerate ccsm processes via tasklist, taskkill /F.
// Uses CSV output for robust parsing. Best-effort; errors are logged but
// do not abort uninstall (idempotency over precision).
// ---------------------------------------------------------------------------

const CCSM_IMAGE_NAMES = [
  'ccsm-daemon.exe',
  'CCSM.exe',
  'CCSM Dev.exe',
];

function execFileP(file, args, opts) {
  return new Promise((resolve) => {
    execFile(file, args, opts || {}, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

async function listCcsmPids() {
  const pids = [];
  for (const image of CCSM_IMAGE_NAMES) {
    const { err, stdout } = await execFileP(
      'tasklist',
      ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'],
      { windowsHide: true },
    );
    if (err) {
      logLine(`tasklist ${image} failed: ${err.message}`);
      continue;
    }
    // CSV rows: "image","pid","session","sessionnum","memusage"
    // tasklist emits "INFO: No tasks ..." on stdout when no match — skip.
    if (/^INFO:/i.test(stdout.trim())) continue;
    for (const line of stdout.split(/\r?\n/)) {
      const m = line.match(/^"([^"]+)","(\d+)"/);
      if (m) pids.push({ image: m[1], pid: Number.parseInt(m[2], 10) });
    }
  }
  return pids;
}

async function killPid(pid) {
  const { err, stderr } = await execFileP(
    'taskkill',
    ['/F', '/T', '/PID', String(pid)],
    { windowsHide: true },
  );
  if (err) {
    logLine(`taskkill ${pid} failed: ${err.message} ${stderr.trim()}`);
    return false;
  }
  return true;
}

async function hardstop() {
  const pids = await listCcsmPids();
  if (pids.length === 0) {
    logLine('hardstop: no ccsm processes found (already stopped)');
    return { ok: true, killed: 0, failed: 0 };
  }
  let killed = 0;
  let failed = 0;
  for (const p of pids) {
    logLine(`hardstop: killing ${p.image} pid=${p.pid}`);
    if (await killPid(p.pid)) killed++;
    else failed++;
  }
  return { ok: failed === 0, killed, failed };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (!args.shutdown) {
    process.stdout.write(HELP);
    return 0;
  }

  logLine(`start pid=${process.pid} timeoutMs=${args.timeoutMs}`);

  // Step 1: try graceful RPC.
  const pipePath = controlPipePath();
  logLine(`graceful: connecting ${pipePath}`);
  const g = await gracefulShutdown(pipePath, args.timeoutMs);
  if (g.ok) {
    logLine(`graceful: ok reason=${g.reason}; exit 0`);
    return 0;
  }

  // Step 2: hardstop fallback. ALWAYS runs even when graceful succeeded
  // would have been preferred — a daemon that didn't ack within the
  // timeout might still be alive but wedged.
  logLine(`graceful: failed reason=${g.reason}; falling back to hardstop`);
  const h = await hardstop();
  if (h.ok) {
    logLine(`hardstop: ok killed=${h.killed} failed=${h.failed}; exit 0`);
    return 0;
  }
  logLine(`hardstop: hard error killed=${h.killed} failed=${h.failed}; exit 1`);
  return 1;
}

// Top-level entry. We deliberately catch every error and log/exit so NSIS
// never sees an uncaught throw (which would surface as cryptic non-zero).
// Gated on `require.main === module` so tests can `require()` this file
// without triggering process.exit.
if (require.main === module) {
  main()
    .then((code) => {
      process.exit(code);
    })
    .catch((err) => {
      logLine(`fatal: ${err && err.stack ? err.stack : String(err)}`);
      // Exit 0 anyway: a fatal in the helper itself shouldn't block
      // uninstall. Hard error is reserved for "we tried to kill and
      // couldn't".
      process.exit(0);
    });
} else {
  // Exports for unit tests.
  module.exports = {
    parseArgs,
    controlPipePath,
    encodeJsonFrame,
    gracefulShutdown,
    hardstop,
    listCcsmPids,
    main,
  };
}
