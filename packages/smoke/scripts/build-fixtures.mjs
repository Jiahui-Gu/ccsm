#!/usr/bin/env node
// R-9 v3.A — smoke build script (Task #15).
//
// One-shot producer of the release artifacts the smoke fixture spawns. Splits
// build from runtime so that:
//   1. `pnpm smoke:run` does not spawn cargo / vite / `tauri dev` — the
//      runtime path is just spawning a release `.exe` that's already on disk.
//   2. The artifact path (`packages/smoke/.fixtures/bin/`) is *physically
//      isolated* from a developer's day-to-day
//      `packages/frontend-tauri/src-tauri/target/`, so a zombie `ccsm-tauri.exe`
//      holding a file lock under the user's `target/` cannot wedge smoke.
//   3. We pin `--target-dir` to `.fixtures/cargo-target/` for the same reason:
//      smoke's cargo build never touches the developer's shared target dir.
//
// Steps:
//   T1. Build @ccsm/daemon (tsc -> packages/daemon/dist/index.mjs).
//        daemon_mgr.rs `resolve_daemon_script` walks up looking for
//        `packages/daemon/dist/index.mjs` from the cwd we spawn the .exe in
//        (REPO_ROOT). So the daemon dist still lives in its normal repo
//        location — only the binary is what we copy out to .fixtures/bin/.
//   T2. Build @ccsm/frontend-tauri (vite -> packages/frontend-tauri/dist/).
//        Tauri's `tauri.conf.json` `frontendDist: "../dist"` is what gets
//        embedded into ccsm-tauri.exe at cargo-build time, so the vite build
//        MUST happen before cargo build.
//   T3. cargo build --release with `--target-dir
//        packages/smoke/.fixtures/cargo-target` to keep the build artifacts
//        out of the user's shared target/.
//   T4. Copy the resulting ccsm-tauri.exe to
//        `packages/smoke/.fixtures/bin/ccsm-tauri.exe`.
//
// NOT done here: spawning cargo / vite from the smoke runtime (orchestrator).
// That's the whole point of this split.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, existsSync, statSync, openSync, closeSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SMOKE_DIR = resolve(__dirname, '..');
const REPO_ROOT = resolve(SMOKE_DIR, '../..');
const FIXTURES_BIN = join(SMOKE_DIR, '.fixtures', 'bin');
const FIXTURES_CARGO_TARGET = join(SMOKE_DIR, '.fixtures', 'cargo-target');

const IS_WINDOWS = process.platform === 'win32';
const EXE_NAME = IS_WINDOWS ? 'ccsm-tauri.exe' : 'ccsm-tauri';

function run(label, cmd, args, cwd, env) {
  process.stderr.write(`\n[smoke:build] ${label}\n  $ ${cmd} ${args.join(' ')}\n  (cwd=${cwd})\n`);
  const r = spawnSync(cmd, args, {
    cwd,
    stdio: 'inherit',
    shell: IS_WINDOWS, // pnpm/cargo .cmd shims on Windows
    env: { ...process.env, ...(env ?? {}) },
  });
  if (r.status !== 0) {
    process.stderr.write(`[smoke:build] ${label} failed (exit=${r.status})\n`);
    process.exit(r.status ?? 1);
  }
}

// T1 — daemon dist (build daemon + its workspace deps)
run(
  'T1 build @ccsm/daemon (+ workspace deps)',
  'pnpm',
  ['--filter', '@ccsm/daemon...', 'build'],
  REPO_ROOT,
);
const daemonDist = join(REPO_ROOT, 'packages/daemon/dist/index.mjs');
if (!existsSync(daemonDist)) {
  process.stderr.write(`[smoke:build] daemon dist missing: ${daemonDist}\n`);
  process.exit(1);
}

// T2 — frontend-tauri vite build (produces ../dist that tauri.conf.json embeds).
// `...` includes workspace deps (@ccsm/ui etc.) so their dist exists for tsc.
run(
  'T2 build @ccsm/frontend-tauri (vite, + workspace deps)',
  'pnpm',
  ['--filter', '@ccsm/frontend-tauri...', 'build'],
  REPO_ROOT,
);

// T3 — cargo --release with isolated target dir
mkdirSync(FIXTURES_CARGO_TARGET, { recursive: true });
const manifestPath = join(REPO_ROOT, 'packages/frontend-tauri/src-tauri/Cargo.toml');
run(
  'T3 cargo build --release (isolated target-dir)',
  'cargo',
  [
    'build',
    '--release',
    '--manifest-path', manifestPath,
    '--target-dir', FIXTURES_CARGO_TARGET,
  ],
  REPO_ROOT,
);

// T4 — copy exe to .fixtures/bin/
mkdirSync(FIXTURES_BIN, { recursive: true });
const builtExe = join(FIXTURES_CARGO_TARGET, 'release', EXE_NAME);
const destExe = join(FIXTURES_BIN, EXE_NAME);
if (!existsSync(builtExe)) {
  process.stderr.write(`[smoke:build] cargo did not produce ${builtExe}\n`);
  process.exit(1);
}

// R-9 v3.D — fail-fast lock detection BEFORE copyFileSync.
//
// If a previous smoke run left a zombie ccsm-tauri.exe (or a webview/wry
// helper that mapped the .exe image) holding a file lock on destExe,
// copyFileSync will fail with EBUSY mid-copy. We detect this up-front by
// trying to open the file for read+write; on Windows that returns EBUSY /
// EPERM if any process holds an exclusive map / write share.
//
// We deliberately do NOT retry-with-sleep here (that's glue, masks the
// real bug) and do NOT spawn taskkill (also glue + can wedge in kernel
// syscalls when there are many zombies). The orchestrator's R-9 v3.D Job
// Object change ensures *new* runs reap their tree on exit; this fail-fast
// is the safety net for any pre-existing zombies (e.g. from before this
// fix landed, or from a TerminateProcess of the smoke runner) so the user
// gets a clear actionable error instead of a confusing copyfile failure
// in the middle of T4.
if (existsSync(destExe)) {
  let fd = -1;
  try {
    fd = openSync(destExe, 'r+');
  } catch (err) {
    const code = (err && typeof err === 'object' && 'code' in err) ? err.code : 'UNKNOWN';
    process.stderr.write(
      `\n[smoke:build] T4 ABORT — destination .exe is locked\n` +
      `  path:  ${destExe}\n` +
      `  errno: ${code} (${err && err.message ? err.message : err})\n` +
      `\n` +
      `Likely cause: a zombie ccsm-tauri.exe / webview helper / wry sandbox\n` +
      `from a previous smoke run is still mapping this .exe image, holding\n` +
      `a Windows file lock. We refuse to retry-with-sleep (it would mask\n` +
      `the real bug) or to taskkill (it deadlocks under high zombie counts).\n` +
      `\n` +
      `What to do:\n` +
      `  1. Identify the locker:\n` +
      `       Get-Process ccsm-tauri | Format-List Id,Path,StartTime\n` +
      `       handle.exe "${destExe}"   # SysInternals handle.exe if installed\n` +
      `  2. Kill it gracefully (close the app), or as a last resort reboot —\n` +
      `     under heavy zombie load 'taskkill /F' itself can wedge.\n` +
      `  3. Re-run \`pnpm smoke:build\`. Subsequent runs will not zombie\n` +
      `     because the orchestrator now binds the Tauri tree to a Win32\n` +
      `     Job Object with KILL_ON_JOB_CLOSE (R-9 v3.D, Task #19).\n`,
    );
    process.exit(2);
  } finally {
    if (fd !== -1) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

copyFileSync(builtExe, destExe);
const sz = statSync(destExe).size;
process.stderr.write(`\n[smoke:build] OK\n  -> ${destExe}\n  size=${sz} bytes\n`);
process.stderr.write(`  daemon=${daemonDist} (resolved at runtime by ccsm-tauri.exe via cwd-relative search)\n`);
