// Smoke orchestrator (Task #2 / R-9 v3.A split: build vs runtime).
//
// Brings up the 3 long-lived processes the cloud-mode happy path requires:
//   1. wrangler dev       — runs the cf-worker (TunnelDO) on http://127.0.0.1:8787
//   2. wrangler pages dev — serves frontend-web's dist + Pages Functions
//      `[[path]].ts` reverse-proxy on http://127.0.0.1:8788; Functions forward
//      `/api/*` + `/token` + `/ws/*` + `/tunnel/*` to the worker above.
//   3. ccsm-tauri.exe (release) — already built by `pnpm smoke:build` into
//      `packages/smoke/.fixtures/bin/ccsm-tauri.exe`. Spawned directly here.
//      The Tauri lib.rs setup hook (R-4, Task #11) auto-spawns the daemon as
//      a Rust child via `daemon_mgr::spawn_daemon_inner`; daemon_mgr resolves
//      `packages/daemon/dist/index.mjs` via cwd-relative search, so we set
//      cwd=REPO_ROOT when spawning the .exe.
//
// R-9 v3.A architecture (Task #15) — what we no longer do:
//   - We do NOT spawn `cargo`. Cargo build is `pnpm smoke:build`'s job, run
//     once before the smoke test, with --target-dir pinned to
//     `.fixtures/cargo-target/` (physically isolated from the developer's
//     `packages/frontend-tauri/src-tauri/target/`).
//   - We do NOT spawn `vite` (frontend-tauri dev server). The release .exe
//     already has the built frontendDist bundled (vite build ran during
//     smoke:build).
//   - We do NOT spawn `tauri dev` / `pnpm tauri dev`. The release .exe is
//     what users actually run, and is what we test.
//   - We do NOT need `VITE_DEV_PORT` / dev-port-collision dance — there is
//     no dev server.
//
// Teardown reverses the spawn order. On Windows we rely on the Tauri Job
// Object to reap the daemon descendant when the Tauri parent dies; non-windows
// uses kill_on_drop semantics. wrangler dev / pages dev are killed via
// process.kill on the spawn handle.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');

const WORKER_PORT = 8787;
const PAGES_PORT = 8788;

interface ProcHandle {
  name: string;
  child: ChildProcess;
  /** Resolves once the process printed its "I'm ready" line. */
  ready: Promise<void>;
}

const handles: ProcHandle[] = [];
let tempDataDir: string | null = null;

function spawnProc(opts: {
  name: string;
  cwd: string;
  cmd: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
  readyMatch: RegExp;
  readyTimeoutMs: number;
}): ProcHandle {
  const child = spawn(opts.cmd, opts.args, {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32', // pnpm.cmd / wrangler.cmd shims on Windows
  });

  const ready = new Promise<void>((resolveReady, rejectReady) => {
    const t = setTimeout(() => {
      rejectReady(new Error(
        `[${opts.name}] ready timeout after ${opts.readyTimeoutMs}ms; readyMatch=${opts.readyMatch}`,
      ));
    }, opts.readyTimeoutMs);

    const watch = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      process.stderr.write(`[${opts.name}] ${text}`);
      if (opts.readyMatch.test(text)) {
        clearTimeout(t);
        resolveReady();
      }
    };
    child.stdout?.on('data', watch);
    child.stderr?.on('data', watch);
    child.on('exit', (code, signal) => {
      clearTimeout(t);
      rejectReady(new Error(
        `[${opts.name}] exited before ready (code=${code}, signal=${signal})`,
      ));
    });
  });

  return { name: opts.name, child, ready };
}

async function killHandle(h: ProcHandle): Promise<void> {
  return new Promise((resolveKill) => {
    if (h.child.exitCode !== null || h.child.signalCode !== null) {
      resolveKill();
      return;
    }
    const t = setTimeout(() => {
      try { h.child.kill('SIGKILL'); } catch { /* ignore */ }
      resolveKill();
    }, 5_000);
    h.child.once('exit', () => {
      clearTimeout(t);
      resolveKill();
    });
    try {
      h.child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');
    } catch {
      // already dead
      clearTimeout(t);
      resolveKill();
    }
  });
}

export default async function globalSetup(): Promise<void> {
  tempDataDir = mkdtempSync(join(tmpdir(), 'ccsm-smoke-'));

  // 1. cf-worker (wrangler dev). Listens on WORKER_PORT.
  const worker = spawnProc({
    name: 'cf-worker',
    cwd: join(REPO_ROOT, 'packages/cf-worker'),
    cmd: 'pnpm',
    args: ['exec', 'wrangler', 'dev', '--local', '--port', String(WORKER_PORT)],
    readyMatch: /Ready on http/i,
    readyTimeoutMs: 60_000,
  });
  handles.push(worker);
  await worker.ready;

  // 2. frontend-web Pages dev. Reverse-proxies /api/*, /token, /ws/*, /tunnel/*
  //    via functions/[[path]].ts to the worker above. Bound on PAGES_PORT.
  //
  //    R-1 fix (Task #6): we serve the *built* `dist/` instead of running
  //    `wrangler pages dev -- pnpm dev` (proxy mode). Reasons:
  //      - `wrangler pages dev <directory> -- <cmd>` is mutually exclusive
  //        in current wrangler (`-- <proxy-cmd>` requires NO directory arg,
  //        and we can't pass a directory + `--port` + `-- pnpm dev` at the
  //        same time without wrangler erroring out at startup), which is
  //        why R-1 wedged the fixture before Task #6.
  //      - Serving `dist/` matches prod Pages deploy semantics: same static
  //        bundle + same `functions/[[path]].ts` reverse-proxy. No vite-dev
  //        middleware divergence.
  //    We build first (cheap incremental on warm tsc/vite caches) before
  //    spawning wrangler. If build is slow on a cold machine, doc'd in
  //    README; cache-mtime gate is intentionally not added here to avoid
  //    drift between smoke and CI.
  const frontendWebCwd = join(REPO_ROOT, 'packages/frontend-web');
  process.stderr.write('[pages-dev] building frontend-web dist/ (one-shot)…\n');
  const buildStart = Date.now();
  const buildResult = spawnSync(
    'pnpm',
    ['--filter', '@ccsm/frontend-web...', 'build'],
    {
      cwd: REPO_ROOT,
      stdio: 'inherit',
      shell: process.platform === 'win32',
    },
  );
  if (buildResult.status !== 0) {
    throw new Error(
      `[pages-dev] frontend-web build failed (exit=${buildResult.status})`,
    );
  }
  const distDir = join(frontendWebCwd, 'dist');
  try { statSync(distDir); } catch {
    throw new Error(`[pages-dev] expected build output at ${distDir} but it does not exist`);
  }
  process.stderr.write(`[pages-dev] build done in ${Date.now() - buildStart}ms; serving ${distDir}\n`);

  const pages = spawnProc({
    name: 'pages-dev',
    cwd: frontendWebCwd,
    cmd: 'pnpm',
    args: [
      'exec',
      'wrangler',
      'pages',
      'dev',
      distDir,
      '--port',
      String(PAGES_PORT),
      '--ip',
      '127.0.0.1',
    ],
    env: {
      // FOLLOWUP (R-2): this env hand-off is currently a no-op — the Pages
      // Function [[path]].ts hard-codes the prod worker origin. Smoke will
      // go red on the next layer once R-1 unwedges.
      SMOKE_WORKER_ORIGIN: `http://127.0.0.1:${WORKER_PORT}`,
    },
    readyMatch: /Ready on http|listening on http/i,
    readyTimeoutMs: 60_000,
  });
  handles.push(pages);
  await pages.ready;

  // 3. Tauri release shell (R-9 v3.A, Task #15).
  //
  //    We spawn the prebuilt `ccsm-tauri.exe` from `.fixtures/bin/` directly.
  //    `pnpm smoke:build` produces this artifact (cargo --release with an
  //    isolated --target-dir under `.fixtures/cargo-target/`), so smoke runtime
  //    never invokes cargo or vite. cwd is REPO_ROOT so daemon_mgr.rs's
  //    cwd-relative search for `packages/daemon/dist/index.mjs` resolves.
  //    The R-4 (Task #11) lib.rs setup hook auto-spawns the daemon — no
  //    webview gesture needed.
  //
  //    FOLLOWUPs left for subsequent R-* tasks (see PR body):
  //      - R-3: daemon_mgr does not propagate CCSM_TUNNEL_URL to the daemon
  //        child yet, so the daemon dials the prod tunnel instead of our
  //        wrangler dev worker. We still set the env on the parent for when
  //        R-3 lands; the daemon currently ignores it.
  //      - CCSM_DB_PATH is also computed here for when daemon_mgr starts
  //        honoring an env override (today daemon_mgr pins db to
  //        app_local_data_dir; smoke pollutes the real %LOCALAPPDATA% until
  //        a follow-up adds an env override).
  const exeName = process.platform === 'win32' ? 'ccsm-tauri.exe' : 'ccsm-tauri';
  const releaseExe = join(__dirname, '..', '.fixtures', 'bin', exeName);
  try { statSync(releaseExe); } catch {
    throw new Error(
      `[tauri-release] artifact missing: ${releaseExe}\n` +
      `Run \`pnpm smoke:build\` first (one-shot release build).`,
    );
  }

  const tauri = spawnProc({
    name: 'tauri-release',
    cwd: REPO_ROOT,
    cmd: releaseExe,
    args: [],
    env: {
      // FOLLOWUP (R-3): daemon_mgr.rs does not currently propagate this env
      // to the daemon child; smoke goes red on the tunnel layer until R-3.
      CCSM_TUNNEL_URL: `ws://127.0.0.1:${WORKER_PORT}/tunnel/default`,
      // FOLLOWUP: daemon currently ignores parent CCSM_DB_PATH because
      // daemon_mgr.rs pins it to app_local_data_dir. Set anyway so a
      // follow-up that switches daemon_mgr to honor an override gets the
      // smoke-private path automatically.
      CCSM_DB_PATH: join(tempDataDir ?? tmpdir(), 'ccsm.db'),
    },
    // The lib.rs setup hook calls spawn_daemon_inner, which logs
    // "[daemon-mgr] resolved daemon script: …" before spawning, then the
    // daemon prints its `{"ready":true,...}` handshake on stdout which
    // daemon_mgr forwards as a Tauri "daemon-ready" event. We match either
    // the Rust-side log or the daemon stdout passthrough.
    readyMatch: /daemon-ready|"ready"\s*:\s*true|handshake ok port=/i,
    readyTimeoutMs: 90_000,
  });
  handles.push(tauri);
  await tauri.ready;

  process.env.SMOKE_BASE_URL = `http://127.0.0.1:${PAGES_PORT}`;
}

export async function globalTeardown(): Promise<void> {
  // Reverse spawn order so the Tauri Job Object reaps daemon first, then
  // pages dev (which owns its workerd), then cf-worker.
  for (const h of [...handles].reverse()) {
    try {
      await killHandle(h);
    } catch (err) {
      process.stderr.write(`[smoke teardown] kill ${h.name} failed: ${(err as Error).message}\n`);
    }
  }
  handles.length = 0;
  if (tempDataDir !== null) {
    try { rmSync(tempDataDir, { recursive: true, force: true }); } catch { /* ignore */ }
    tempDataDir = null;
  }
}
