// scripts/dogfood-pr-followup-inspect-process.mjs
//
// Follow-up to #1379 task #51: validate `inspectProcessWin` falls
// through wmic → PowerShell CIM → tasklist cleanly. We can't simulate
// Win11 24H2 (where wmic is gone) from a non-24H2 machine, so this
// probe instead invokes the PowerShell path directly with the current
// process's PID and asserts the shape we depend on (ExecutablePath +
// CommandLine present). If the PS contract changes (older PS, locale,
// etc.) this probe surfaces it before the field reports do.
//
// Exit 0 = PASS, 1 = FAIL.

import { spawnSync } from 'node:child_process';

if (process.platform !== 'win32') {
  console.log('SKIP (non-Windows)');
  process.exit(0);
}

const pid = process.pid;
const ps = spawnSync(
  'powershell',
  [
    '-NoProfile',
    '-NonInteractive',
    '-Command',
    `Get-CimInstance Win32_Process -Filter "ProcessId=${pid}" | ` +
      `Select-Object ExecutablePath,CommandLine | ConvertTo-Json -Compress`,
  ],
  { encoding: 'utf8' },
);

if (ps.status !== 0) {
  console.error(`FAIL: powershell exited ${ps.status}`);
  console.error(`stderr: ${ps.stderr}`);
  process.exit(1);
}

let obj;
try {
  obj = JSON.parse(ps.stdout);
} catch (e) {
  console.error(`FAIL: ConvertTo-Json output did not parse — ${e.message}`);
  console.error(`stdout: ${ps.stdout.slice(0, 500)}`);
  process.exit(1);
}

const exe = String(obj?.ExecutablePath ?? '').trim();
const cmd = String(obj?.CommandLine ?? '').trim();
if (!exe || !cmd) {
  console.error(
    `FAIL: PS CIM should return both ExecutablePath and CommandLine for current process. Got exe=${JSON.stringify(exe)} cmd=${JSON.stringify(cmd).slice(0, 200)}`,
  );
  process.exit(1);
}
console.log(`exe = ${exe}`);
console.log(`cmd = ${cmd.slice(0, 120)}${cmd.length > 120 ? '…' : ''}`);
console.log('PASS');
