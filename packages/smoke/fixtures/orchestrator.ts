// Smoke orchestrator (Task #2).
//
// Brings up the 3 long-lived processes the cloud-mode happy path requires:
//   1. wrangler dev    — runs the cf-worker (TunnelDO) on http://127.0.0.1:8787
//   2. wrangler pages dev — serves frontend-web's dist + Pages Functions
//      `[[path]].ts` reverse-proxy on http://127.0.0.1:8788; Functions forward
//      `/api/*` + `/token` + `/ws/*` + `/tunnel/*` to the worker above.
//   3. tauri dev       — Rust shell that spawns the daemon as a child via
//      `daemon_mgr::start_daemon`. The daemon prints handshake JSON
//      `{ready, port, token}` on stdout; the shell parses it and emits a
//      `daemon-ready` Tauri event. The shell is also responsible for setting
//      `CCSM_TUNNEL_URL=ws://127.0.0.1:8787/tunnel/default` so the daemon
//      dials our local wrangler dev worker instead of the prod
//      `wss://cc-sm.pages.dev` tunnel.
//
// Teardown reverses the spawn order. On Windows we rely on the Tauri Job
// Object to reap the daemon descendant when the Tauri parent dies; non-windows
// uses kill_on_drop semantics. wrangler dev / pages dev are killed via
// process.kill on the spawn handle (their workerd children are reaped by the
// shell on SIGTERM).
//
// Status (red phase, Task #2): this orchestrator is intentionally a single
// file that exercises every plumbing concern listed above. Most of those
// concerns are NOT yet implemented in the product:
//   - Tauri's `start_daemon` does not accept / honor a CCSM_TUNNEL_URL env
//     override (daemon_mgr.rs does not pass any tunnel-url env through).
//   - `tauri dev` has no headless / no-window mode wired into tauri.conf.json
//     so we can't run it on a CI-style headless workstation; the human dev
//     sees a real window pop.
//   - The webview's `App.tsx` does not auto-invoke `start_daemon` on mount,
//     so the daemon is never spawned without a manual click.
//   - The Pages Function `[[path]].ts` is configured for the production
//     wss://cc-sm.pages.dev origin only; running it under wrangler pages dev
//     against http://127.0.0.1:8787 requires either (a) a `?worker=` override
//     param the Function honors, or (b) an env-var binding.
//   - There is no `?daemon=` token-injection path that lets Playwright's
//     chromium pick up the daemon-minted token without going through the
//     SPA's sessionStorage bootstrap (the prod path uses a Pages Function
//     header injection that doesn't fire under wrangler pages dev).
//
// All of those gaps are surfaced as the Phase 1 red output: the orchestrator
// fails fast at the first missing piece. Phase 2 (turning red → green) is
// scoped as a series of followup tasks (see PR body) so the changes do not
// land in this single TDD-spec PR.
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

  // 3. Tauri dev shell. Spawns the daemon as a Rust child via
  //    daemon_mgr::start_daemon. We need the daemon to dial OUR local worker,
  //    not the prod tunnel — that requires daemon_mgr.rs to honor a
  //    CCSM_TUNNEL_URL env override (see followup #2-A).
  const tauri = spawnProc({
    name: 'tauri-dev',
    cwd: join(REPO_ROOT, 'packages/frontend-tauri'),
    cmd: 'pnpm',
    args: ['tauri', 'dev'],
    env: {
      // FOLLOWUP: daemon_mgr.rs does not currently propagate this env to the
      // daemon child. Smoke goes red here.
      CCSM_TUNNEL_URL: `ws://127.0.0.1:${WORKER_PORT}/tunnel/default`,
      // Override db path to a smoke-private temp dir so we don't pollute the
      // real %LOCALAPPDATA%/dev.ccsm.tauri/ccsm.db.
      CCSM_DB_PATH: join(tempDataDir, 'ccsm.db'),
    },
    readyMatch: /daemon-ready|handshake ok port=/i,
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
