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
import { createSmokeJobObject, type SmokeJobObject } from './job-object.js';

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
// R-9 v3.D: Job Object that wraps the Tauri release exe (and its descendants —
// webview helper, daemon Node child) so that any death of the smoke process
// kernel-reaps the whole tree. Non-Windows = no-op.
let tauriJob: SmokeJobObject | null = null;

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

// R-13 (Task #31) — stage marker helper. Wraps each setup phase in a
// monotonically-numbered `[smoke stage N/10: <name>]` start/ok/FAILED log line
// so a red smoke run no longer needs the reader to guess which jump (cf-worker
// spawn / pages-dev build / tauri spawn / daemon handshake / tunnel ws) of the
// boot pipeline broke. Failures rethrow so globalSetup's catch arm runs the
// existing teardown (line ~134); we do not change control flow.
const STAGE_TOTAL = 10;
async function runStage<T>(n: number, name: string, fn: () => Promise<T> | T): Promise<T> {
  const start = Date.now();
  process.stderr.write(`[smoke stage ${n}/${STAGE_TOTAL}: ${name}] start\n`);
  try {
    const result = await fn();
    process.stderr.write(`[smoke stage ${n}/${STAGE_TOTAL}: ${name}] ok in ${Date.now() - start}ms\n`);
    return result;
  } catch (err) {
    const msg = (err as Error).message;
    process.stderr.write(
      `[smoke stage ${n}/${STAGE_TOTAL}: ${name}] FAILED in ${Date.now() - start}ms: ${msg}\n`,
    );
    throw err;
  }
}

// R-13 — attach a tail-watcher to the tauri child stdout/stderr that prints
// stage markers 7-10 as their substrings flow by. These stages are logically
// inside `await tauri.ready` (the lib.rs setup hook auto-spawns the daemon
// child, the daemon handshake fires daemon-mgr's "daemon-ready" Tauri event,
// and the daemon then dials the tunnel ws). Orchestrator does not drive them
// directly, so we cannot wrap them in runStage; we observe them instead.
// Observed-only marker: prints `[smoke stage N/10: <name>] observed at +Xms`
// on first match, no FAILED variant (a missing stage manifests as the next
// stage's runStage timing out, which still fingerprints which jump broke).
function attachTauriStageWatcher(child: ChildProcess, t0: number): void {
  const stages: Array<{ n: number; name: string; pattern: RegExp; seen: boolean }> = [
    { n: 7, name: 'daemon spawn',          pattern: /daemon-mgr.*resolved daemon script|spawn_daemon_inner/i, seen: false },
    { n: 8, name: 'daemonJob assign pid',  pattern: /job_object.*assign|daemon.*pid=\d+.*assigned/i,           seen: false },
    { n: 9, name: 'daemon handshake ok',   pattern: /"ready"\s*:\s*true|handshake ok port=|daemon-ready/i,     seen: false },
    { n: 10, name: 'tunnel ws connected',  pattern: /tunnel.*ws.*(connected|open)|tunnel-do.*upgrade/i,        seen: false },
  ];
  const watch = (chunk: Buffer): void => {
    const text = chunk.toString('utf8');
    for (const s of stages) {
      if (!s.seen && s.pattern.test(text)) {
        s.seen = true;
        process.stderr.write(
          `[smoke stage ${s.n}/${STAGE_TOTAL}: ${s.name}] observed at +${Date.now() - t0}ms\n`,
        );
      }
    }
  };
  child.stdout?.on('data', watch);
  child.stderr?.on('data', watch);
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
  try {
    await globalSetupInner();
  } catch (err) {
    // R-9 v3.D — if setup fails midway (e.g. tauri readyMatch timeout),
    // run teardown to release the Job Object + kill any spawned processes,
    // otherwise we leak zombies that lock .fixtures/bin/ccsm-tauri.exe.
    process.stderr.write(`[smoke setup] failed: ${(err as Error).message} — running teardown\n`);
    try { await globalTeardown(); } catch (teardownErr) {
      process.stderr.write(
        `[smoke setup] teardown after failure also failed: ${(teardownErr as Error).message}\n`,
      );
    }
    throw err;
  }
}

async function globalSetupInner(): Promise<void> {
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
  await runStage(1, 'cf-worker spawn ready', () => worker.ready);

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
  const distDir = join(frontendWebCwd, 'dist');
  await runStage(2, 'pages-dev build done', () => {
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
    try { statSync(distDir); } catch {
      throw new Error(`[pages-dev] expected build output at ${distDir} but it does not exist`);
    }
    process.stderr.write(`[pages-dev] build done in ${Date.now() - buildStart}ms; serving ${distDir}\n`);
  });

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
  await runStage(3, 'pages-dev spawn ready', () => pages.ready);

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

  const tauri = await runStage(4, 'tauri spawn', () => spawnProc({
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
  }));
  handles.push(tauri);

  // R-13 — start observing tauri child output for stage 7-10 substrings as
  // soon as the child is alive, BEFORE the readyMatch await, so the markers
  // print in real time rather than getting buffered behind stage 6.
  const tauriT0 = Date.now();
  attachTauriStageWatcher(tauri.child, tauriT0);

  // R-9 v3.D — bind the Tauri process tree to a Job Object with
  // KILL_ON_JOB_CLOSE *immediately after spawn, before awaiting ready*. This
  // way:
  //   - any descendant the Tauri exe spawns later (webview helper, wry
  //     sandbox, the daemon Node child) inherits the Job association
  //     automatically (we do NOT set JOB_OBJECT_LIMIT_BREAKAWAY_OK), so the
  //     whole tree dies when our Job handle closes;
  //   - if globalSetup throws between spawn and `await tauri.ready` (e.g.
  //     readyMatch timeout), globalTeardown's `tauriJob.close()` still
  //     reaps everything, instead of leaving zombies that lock
  //     .fixtures/bin/ccsm-tauri.exe and wedge the next smoke:build T4.
  //
  // The Tauri Rust side has its own Job Object for the daemon (T9, see
  // packages/frontend-tauri/src-tauri/src/job_object.rs); that handles the
  // case where a *user* hard-kills ccsm-tauri.exe in production. This Job
  // is the smoke-side equivalent for the case where smoke (the parent of
  // ccsm-tauri.exe) crashes.
  if (tauri.child.pid !== undefined) {
    await runStage(5, 'tauriJob assign pid', () => {
      tauriJob = createSmokeJobObject();
      try {
        tauriJob.assign(tauri.child.pid as number);
        process.stderr.write(`[smoke] assigned tauri pid=${tauri.child.pid} to Job Object\n`);
      } catch (err) {
        process.stderr.write(
          `[smoke] WARN: failed to assign tauri pid=${tauri.child.pid} to Job Object: ${(err as Error).message}\n` +
          `[smoke] WARN: descendants may zombie; smoke:build T4 fail-fast will catch on next run\n`,
        );
        try { tauriJob.close(); } catch { /* ignore */ }
        tauriJob = null;
      }
    });
  }

  await runStage(6, 'tauri ready', () => tauri.ready);

  process.env.SMOKE_BASE_URL = `http://127.0.0.1:${PAGES_PORT}`;
}

export async function globalTeardown(): Promise<void> {
  // R-9 v3.D — close the Job Object FIRST. Under
  // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE this kernel-terminates ccsm-tauri.exe
  // and every descendant it spawned (webview helper, wry sandbox, daemon
  // Node child) atomically — releasing the file lock on
  // .fixtures/bin/ccsm-tauri.exe so the next `pnpm smoke:build` T4 copy
  // does not hit EBUSY. Doing this before per-handle kill ensures a graceful
  // teardown path doesn't race with an exited-but-still-mapped child.
  if (tauriJob !== null) {
    try { tauriJob.close(); } catch (err) {
      process.stderr.write(`[smoke teardown] tauriJob.close failed: ${(err as Error).message}\n`);
    }
    tauriJob = null;
  }

  // Reverse spawn order so any process not bound to the Job (cf-worker,
  // pages-dev) still gets a chance at clean SIGTERM.
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
