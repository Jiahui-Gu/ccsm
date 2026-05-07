// Spawn helper for tauri-driver (Tauri 2 WebDriver proxy).
//
// Why a fixture instead of inline in wdio.conf:
// - Single Responsibility (dev.md §2 SRP): this module is a *sink* (spawns a
//   subprocess) — config consumes the handle; spec consumes nothing here.
// - Allows future spec-level reuse (e.g. multi-app runs) without rewriting.
//
// tauri-driver expects PATH to include both `tauri-driver.exe` (cargo bin)
// and `msedgedriver.exe`. We fall back to known locations because bash
// shells on this machine do not always inherit ~/.cargo/bin (per memo
// feedback_local_windows_before_ci.md observations on T11 GUI verifier).

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();

function resolveTauriDriver(): string {
  const envPath = process.env.TAURI_E2E_TAURI_DRIVER;
  if (envPath && existsSync(envPath)) return envPath;
  const cargo = path.join(HOME, '.cargo', 'bin', 'tauri-driver.exe');
  if (existsSync(cargo)) return cargo;
  return 'tauri-driver';
}

function resolveMsedgedriver(): string {
  const envPath = process.env.TAURI_E2E_MSEDGEDRIVER;
  if (envPath && existsSync(envPath)) return envPath;
  const home = path.join(HOME, 'bin', 'msedgedriver.exe');
  if (existsSync(home)) return home;
  return 'msedgedriver';
}

export interface TauriDriverHandle {
  kill: () => void;
  proc: ChildProcess;
}

/** Spawn tauri-driver and resolve once it's listening on :4444. */
export async function spawnTauriDriver(): Promise<TauriDriverHandle> {
  const driver = resolveTauriDriver();
  const edge = resolveMsedgedriver();

  // tauri-driver --native-driver <msedgedriver path> --port 4444
  const args = ['--native-driver', edge, '--port', '4444'];
  // eslint-disable-next-line no-console
  console.log(`[tauri-driver] spawn: ${driver} ${args.join(' ')}`);

  const proc = spawn(driver, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    // cwd MUST be the monorepo root so the Rust resolve_daemon_script() (T8)
    // finds packages/daemon/dist/index.mjs via its third candidate
    // `cwd.join("packages/daemon/dist/index.mjs")`. The prod .exe does NOT
    // yet bundle daemon as sidecar (TODO is T14), so cwd-walk is the only
    // mechanism to locate it. cwd of the .exe is inherited from msedgedriver,
    // which is in turn spawned by tauri-driver — both inherit ours here.
    cwd: path.resolve(
      path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')),
      '..',
      '..',
      '..',
    ),
  });

  proc.stdout?.on('data', (b: Buffer) => {
    process.stdout.write(`[tauri-driver:out] ${b.toString()}`);
  });
  proc.stderr?.on('data', (b: Buffer) => {
    process.stderr.write(`[tauri-driver:err] ${b.toString()}`);
  });
  proc.on('exit', (code, sig) => {
    // eslint-disable-next-line no-console
    console.log(`[tauri-driver] exit code=${code} sig=${sig}`);
  });

  // Poll port 4444 ready (up to 10s).
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch('http://127.0.0.1:4444/status');
      if (res.ok || res.status === 404 || res.status === 405) break;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  return {
    proc,
    kill: () => {
      if (!proc.killed) proc.kill('SIGTERM');
    },
  };
}
