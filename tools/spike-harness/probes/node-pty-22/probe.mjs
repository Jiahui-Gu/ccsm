#!/usr/bin/env node
// T9.10 node-pty Node 22 ABI probe.
//
// Forever-stable contract (per tools/spike-harness/README.md):
//   args:   none
//   env:    PROBE_TIMEOUT_MS (optional, default 5000)
//   stdout: one JSON line {ok, platform, arch, nodeVersion, abi, pty:{cols,rows},
//                          payload, durationMs, nodePtyVersion, addonPath}
//   exit:   0 on success ("hello-pty" observed), 1 on any failure
//
// Runs `node -e "console.log('hello-pty')"` inside a node-pty session, reads
// the merged TTY output, and verifies the literal "hello-pty" appears
// (followed by either CRLF or LF — both forms are accepted because
// ConPTY/winpty/unix ptys differ in line termination).

import { spawn } from 'node-pty';
import { createRequire } from 'node:module';
import { realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);
const TIMEOUT_MS = Number.parseInt(process.env.PROBE_TIMEOUT_MS ?? '5000', 10);

function fail(reason, extra = {}) {
  process.stdout.write(
    JSON.stringify({ ok: false, reason, ...extra }) + '\n',
  );
  process.exit(1);
}

function locateAddon() {
  // node-pty exports `pty.node` from build/Release; resolve via require.resolve
  // on the package then walk to build/Release/pty.node.
  try {
    const pkgJson = require.resolve('node-pty/package.json');
    const root = dirname(pkgJson);
    const prebuildDir = join(
      root,
      'prebuilds',
      `${process.platform}-${process.arch}`,
    );
    const candidates = [
      join(root, 'build', 'Release', 'pty.node'),
      join(root, 'build', 'Release', 'conpty.node'),
      join(root, 'build', 'Release', 'winpty.node'),
      join(prebuildDir, 'pty.node'),
      join(prebuildDir, 'conpty.node'),
    ];
    return candidates
      .filter((p) => {
        try {
          realpathSync(p);
          return true;
        } catch {
          return false;
        }
      })
      .map((p) => realpathSync(p));
  } catch (e) {
    return { error: String(e) };
  }
}

const start = Date.now();
const isWin = process.platform === 'win32';
const shell = isWin ? process.execPath : process.execPath;
const args = ['-e', "console.log('hello-pty')"];

let term;
try {
  term = spawn(shell, args, {
    name: 'xterm-color',
    cols: 80,
    rows: 24,
    cwd: process.cwd(),
    env: process.env,
  });
} catch (e) {
  fail('spawn-failed', { error: String(e) });
}

let buf = '';
let done = false;

const timer = setTimeout(() => {
  if (done) return;
  done = true;
  try {
    term.kill();
  } catch {
    /* ignore */
  }
  fail('timeout', { partial: buf, timeoutMs: TIMEOUT_MS });
}, TIMEOUT_MS);

term.onData((d) => {
  buf += d;
  if (/hello-pty(\r\n|\n)/.test(buf) && !done) {
    done = true;
    clearTimeout(timer);
    try {
      term.kill();
    } catch {
      /* ignore */
    }
    let nodePtyVersion = 'unknown';
    try {
      nodePtyVersion = require('node-pty/package.json').version;
    } catch {
      /* ignore */
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        abi: process.versions.modules,
        pty: { cols: 80, rows: 24 },
        payload: buf.includes('hello-pty\r\n') ? 'CRLF' : 'LF',
        durationMs: Date.now() - start,
        nodePtyVersion,
        addonPath: locateAddon(),
      }) + '\n',
    );
    process.exit(0);
  }
});

term.onExit(({ exitCode, signal }) => {
  if (done) return;
  done = true;
  clearTimeout(timer);
  fail('exited-without-marker', { exitCode, signal, output: buf });
});
