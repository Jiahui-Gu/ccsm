// Batch runner for every `scripts/probe-e2e-*.mjs`.
//
// - Discovers probes by glob, sorts deterministically.
// - Runs them serially (Electron can't share its singleton lock — parallel
//   launches race on user-data-dir and port allocation).
// - 30s wall-clock timeout per probe (kill tree on overrun).
// - Prints a final table; exit code = max child exit code (0 if all green).
// - Skip list via `E2E_SKIP=name1,name2` (matches the suffix after
//   `probe-e2e-` and before `.mjs`, e.g. `E2E_SKIP=streaming,tray`).
//
// Run: `node scripts/run-all-e2e.mjs`

import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const TIMEOUT_MS = 30_000;
const PROBE_PREFIX = 'probe-e2e-';

const skipRaw = (process.env.E2E_SKIP || '').trim();
const skipSet = new Set(
  skipRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
);

function probeName(file) {
  return file.slice(PROBE_PREFIX.length, -'.mjs'.length);
}

const allFiles = readdirSync(SCRIPTS_DIR)
  .filter((f) => f.startsWith(PROBE_PREFIX) && f.endsWith('.mjs'))
  .sort();

if (allFiles.length === 0) {
  console.error('[run-all-e2e] no probes found');
  process.exit(1);
}

console.log(`[run-all-e2e] discovered ${allFiles.length} probe(s)`);
if (skipSet.size > 0) {
  console.log(`[run-all-e2e] skipping: ${[...skipSet].join(', ')}`);
}

/** @type {Array<{name: string, status: 'passed'|'failed'|'skipped'|'timeout', code: number, ms: number, stderrTail: string}>} */
const results = [];

for (const file of allFiles) {
  const name = probeName(file);
  if (skipSet.has(name)) {
    results.push({ name, status: 'skipped', code: 0, ms: 0, stderrTail: '' });
    console.log(`\n[run-all-e2e] SKIP  ${name}`);
    continue;
  }

  const full = path.join(SCRIPTS_DIR, file);
  console.log(`\n[run-all-e2e] RUN   ${name}`);

  const started = Date.now();
  const { code, timedOut, stderrTail } = await runOne(full);
  const ms = Date.now() - started;

  let status;
  if (timedOut) status = 'timeout';
  else if (code === 0) status = 'passed';
  else status = 'failed';

  results.push({ name, status, code, ms, stderrTail });
  console.log(`[run-all-e2e] ${status.toUpperCase().padEnd(6)} ${name} (${ms}ms, exit=${code})`);
}

// --- summary ---
const nameWidth = Math.max(...results.map((r) => r.name.length), 4);
const symbol = (s) => (s === 'passed' ? '[OK]' : s === 'skipped' ? '[--]' : '[XX]');

console.log('\n=== E2E summary ===');
for (const r of results) {
  console.log(
    `${symbol(r.status)} ${r.name.padEnd(nameWidth)}  ${r.status.padEnd(7)} ${String(r.ms).padStart(6)}ms  exit=${r.code}`
  );
}

const failed = results.filter((r) => r.status === 'failed' || r.status === 'timeout');
if (failed.length > 0) {
  console.log(`\n=== failures (${failed.length}) ===`);
  for (const r of failed) {
    console.log(`\n--- ${r.name} (${r.status}) ---`);
    console.log(r.stderrTail || '<no stderr captured>');
  }
}

const passed = results.filter((r) => r.status === 'passed').length;
const skipped = results.filter((r) => r.status === 'skipped').length;
console.log(
  `\n=== totals: ${passed} passed, ${failed.length} failed, ${skipped} skipped, ${results.length} total ===`
);

const exit = results.reduce((acc, r) => {
  if (r.status === 'skipped' || r.status === 'passed') return acc;
  return Math.max(acc, r.code === 0 ? 1 : r.code);
}, 0);
process.exit(exit);

/**
 * Spawn one probe with `process.execPath` (the Node binary running this
 * runner). `shell: false` keeps Windows path quoting predictable.
 *
 * @param {string} scriptPath
 * @returns {Promise<{code: number, timedOut: boolean, stderrTail: string}>}
 */
function runOne(scriptPath) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      shell: false,
      stdio: ['ignore', 'inherit', 'pipe'],
      env: process.env,
    });

    /** @type {string[]} */
    const stderrLines = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      // Mirror to our stderr so live tailing works…
      process.stderr.write(chunk);
      // …and remember the last few lines for the summary table.
      for (const line of chunk.split(/\r?\n/)) {
        if (line.length > 0) stderrLines.push(line);
        if (stderrLines.length > 200) stderrLines.shift();
      }
    });

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        // SIGKILL: probes spawn Electron, which won't always honor SIGTERM in 30s.
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, TIMEOUT_MS);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      const tail = stderrLines.slice(-5).join('\n');
      resolve({
        code: code ?? (signal ? 1 : 1),
        timedOut,
        stderrTail: timedOut ? `(killed after ${TIMEOUT_MS}ms)\n${tail}` : tail,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: 1, timedOut: false, stderrTail: `spawn error: ${err.message}` });
    });
  });
}
