// Batch runner for every `scripts/probe-e2e-*.mjs` AND every
// `scripts/harness-*.mjs` themed harness. This includes the mobile remote relay
// harness, which owns its dynamically-ported Wrangler dev process.
//
// - Discovers probes by glob, sorts deterministically.
// - Runs them serially (Electron can't share its singleton lock — parallel
//   launches race on user-data-dir and port allocation).
// - 30s wall-clock timeout per probe; 5min for harness-* (they pack many
//   cases into one launch).
// - Prints a final table; exit code = max child exit code (0 if all green).
// - Skip list via `E2E_SKIP=name1,name2` (matches the suffix after
//   `probe-e2e-` and before `.mjs`, e.g. `E2E_SKIP=streaming,tray`).
//
// Run: `node scripts/run-all-e2e.mjs`

import { spawn, spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveAutoUpdaterEnv } from './probe-helpers/autoUpdaterGuard.mjs';

/**
 * Tree-kill a process by PID. The probes spawn `node`, which spawns Electron,
 * which spawns GPU/utility/renderer helpers. Killing the top `node` (the only
 * thing Node's `child.kill()` reaches) leaves the Electron helpers as orphans
 * that accumulate across the 80+ probe run — repro: `tasklist | findstr
 * electron.exe` shows 30+ leaked processes after a full run.
 *
 * Windows: `taskkill /T /F /PID` walks the process tree.
 * POSIX: each probe owns a detached process group, so a negative PID reaches
 * the probe and descendants such as Electron or Wrangler.
 *
 * @param {import('node:child_process').ChildProcess} child
 */
function treeKill(child) {
  const pid = child.pid;
  if (pid == null) return;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
    }
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch { /* ignore */ }
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = __dirname;
const PROBE_TIMEOUT_MS = 30_000;
const HARNESS_TIMEOUT_MS = 5 * 60_000;
const PROBE_PREFIX = 'probe-e2e-';
const HARNESS_PREFIX = 'harness-';

function probeName(file) {
  if (file.startsWith(HARNESS_PREFIX)) return file.slice(0, -'.mjs'.length);
  return file.slice(PROBE_PREFIX.length, -'.mjs'.length);
}

/**
 * Build the env every spawned harness/probe child process gets. Extracted
 * (and exported) so unit tests can pin the auto-updater isolation guard
 * (`DISABLE_AUTOUPDATER`) without spawning real children — this is
 * defense-in-depth on top of the same guard applied at each child's own
 * Electron-launch seam (`launchCcsmIsolated` / `buildLaunchOpts`), so a full
 * `npm run probe:e2e` run can't lose the guard even if some future harness
 * bypasses both of those and shells out to `claude` directly from its own
 * process env.
 *
 * @param {NodeJS.ProcessEnv} [baseEnv]
 * @returns {NodeJS.ProcessEnv}
 */
export function buildChildEnv(baseEnv = process.env) {
  return {
    ...baseEnv,
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    // Default probes to hidden-window mode so a 64-probe run doesn't
    // strobe focus stealing across the user's desktop. Individual
    // probes can still launch electron directly with their own env
    // when run by hand for debugging (no CCSM_E2E_HIDDEN set).
    CCSM_E2E_HIDDEN: baseEnv.CCSM_E2E_HIDDEN ?? '1',
    ...resolveAutoUpdaterEnv(baseEnv),
  };
}

/**
 * Spawn one probe with `process.execPath` (the Node binary running this
 * runner). `shell: false` keeps Windows path quoting predictable.
 *
 * @param {string} scriptPath
 * @param {number} timeoutMs
 * @returns {Promise<{code: number, timedOut: boolean, stderrTail: string}>}
 */
function runOne(scriptPath, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      shell: false,
      stdio: ['ignore', 'inherit', 'pipe'],
      env: buildChildEnv(process.env),
      // POSIX needs a dedicated process group so timeout cleanup reaches
      // descendants. Windows uses taskkill's process-tree traversal.
      detached: process.platform !== 'win32',
      windowsHide: true,
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
      // Tree-kill: SIGKILL on the top `node` does NOT cascade to the Electron
      // helpers it spawned. See `treeKill` for details.
      treeKill(child);
    }, timeoutMs);

    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      // Belt-and-suspenders: even on clean exit, sweep the tree. If the probe
      // forgot `app.close()` in some error path, the Electron helpers are
      // still alive at this point — accumulate across 80+ probes and the
      // machine is unusable. `taskkill` on a dead PID is a harmless no-op.
      treeKill(child);
      const tail = stderrLines.slice(-5).join('\n');
      resolve({
        code: code ?? (signal ? 1 : 1),
        timedOut,
        stderrTail: timedOut ? `(killed after ${timeoutMs}ms)\n${tail}` : tail,
      });
    });

    child.on('error', (err) => {
      clearTimeout(timer);
      treeKill(child);
      resolve({ code: 1, timedOut: false, stderrTail: `spawn error: ${err.message}` });
    });
  });
}

/**
 * Discover, run, and summarize every harness/probe. Exported (not just
 * guarded below) so a caller with a real reason to drive the full suite
 * programmatically can `import { main } from './run-all-e2e.mjs'` — but
 * ordinary `import` of this module (e.g. from a unit test targeting
 * `buildChildEnv`) must NOT trigger this. See the `isMainModule` guard at
 * the bottom of the file.
 */
export async function main() {
  const skipRaw = (process.env.E2E_SKIP || '').trim();
  const skipSet = new Set(
    skipRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  );

  const probeFiles = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith(PROBE_PREFIX) && f.endsWith('.mjs'))
    .sort();
  const harnessFiles = readdirSync(SCRIPTS_DIR)
    .filter((f) => f.startsWith(HARNESS_PREFIX) && f.endsWith('.mjs'))
    .sort();
  // Run harnesses FIRST — they're slower per-file but pack many cases, so
  // failing fast on a regression in a merged case beats waiting for 70 cold
  // launches.
  const allFiles = [...harnessFiles, ...probeFiles];

  if (allFiles.length === 0) {
    console.error('[run-all-e2e] no probes or harnesses found');
    process.exit(1);
  }

  console.log(`[run-all-e2e] discovered ${harnessFiles.length} harness(es) + ${probeFiles.length} probe(s)`);
  if (skipSet.size > 0) {
    console.log(`[run-all-e2e] skipping (E2E_SKIP): ${[...skipSet].join(', ')}`);
  }

  /** @type {Array<{name: string, status: 'passed'|'failed'|'skipped'|'timeout', code: number, ms: number, stderrTail: string}>} */
  const results = [];

  for (const file of allFiles) {
    const name = probeName(file);
    const isHarness = file.startsWith(HARNESS_PREFIX);
    if (skipSet.has(name)) {
      results.push({ name, status: 'skipped', code: 0, ms: 0, stderrTail: '' });
      console.log(`\n[run-all-e2e] SKIP  ${name}`);
      continue;
    }

    const full = path.join(SCRIPTS_DIR, file);
    console.log(`\n[run-all-e2e] RUN   ${name}`);

    const started = Date.now();
    const timeoutMs = isHarness ? HARNESS_TIMEOUT_MS : PROBE_TIMEOUT_MS;
    const { code, timedOut, stderrTail } = await runOne(full, timeoutMs);
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
}

// Only run the suite when this file is executed directly (`node
// scripts/run-all-e2e.mjs`), never on `import` — a unit test importing this
// module to reach `buildChildEnv` must not accidentally kick off the entire
// real-Claude E2E suite as an import side effect.
const isMainModule = process.argv[1] != null && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  await main();
}
