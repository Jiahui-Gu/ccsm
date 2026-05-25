#!/usr/bin/env node
// Dev-only wrapper around `electron .`. Pieces of friction it removes:
//
//   1. Single-instance lock.  ccsm's prod build calls
//      `app.requestSingleInstanceLock()` at module load so duplicate desktop-
//      icon double-clicks don't fork zombies. When you're using your installed
//      ccsm to develop ccsm, that lock also blocks `npm run dev`. The lock
//      already has an opt-out (`CCSM_E2E_NO_SINGLE_INSTANCE=1`, originally
//      added for parallel E2E probes); this wrapper sets it.
//
//   2. userData collision.  Electron derives `app.getPath('userData')` from
//      `productName`, which is "CCSM" in both prod and dev. Without an
//      override, dev runs would read/write the same SQLite DB and prefs as
//      your installed ccsm — risky even after exit (WAL recovery, schema
//      migrations). We point the dev instance at `.dev-userdata/` inside the
//      worktree via Electron's `--user-data-dir` switch.
//
//   3. Dev vs installed CCSM identity.  Both run as `CCSM.exe` /
//      `electron.exe`; tasklist / Alt-Tab / Task Manager can't tell them
//      apart, so accidental `taskkill /IM CCSM.exe` kills the user's
//      working installed session. Setting `CCSM_DEV=1` lets main.ts
//      rename the app to "CCSM (dev)" and createWindow tag the title
//      "CCSM [dev]" — see electron/main.ts and electron/window/createWindow.ts.
//
//   4. Stale-port detection.  webpack-dev-server (sibling `dev:web`)
//      listens on :4100. If a previous `npm run dev` left zombie
//      processes, the new run dies with `EADDRINUSE` mid-bringup. We
//      probe :4100 BEFORE spawning electron and refuse to kill blindly:
//      identify the holder, auto-kill only if it's an electron pointed
//      at THIS repo, otherwise print PID / path / CommandLine and bail.
//      Rule from feedback_never_blind_kill_ccsm.md: never kill
//      ambiguous CCSM.exe processes.
//
// Cross-platform: spawning Node with explicit arg/env propagation works on
// Windows without `cross-env`. Stdio is inherited so logs and Ctrl-C behave
// exactly like running `electron .` directly.

import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const userDataDir = resolve(repoRoot, '.dev-userdata');
mkdirSync(userDataDir, { recursive: true });

// ─────────────────────── Port :4100 preflight ────────────────────────
// Goal: catch the leftover-dev-process case BEFORE webpack-dev-server
// crashes with EADDRINUSE, and never blind-kill an ambiguous CCSM.exe.
preflightPort4100();

function preflightPort4100() {
  if (process.platform !== 'win32') {
    // Non-Windows preflight is opt-in; the failure mode that motivated
    // this (taskkill /IM blasting installed CCSM) is Windows-specific.
    return;
  }
  const holderPid = findListenerPidWin('4100');
  if (!holderPid) return;

  const info = inspectProcessWin(holderPid);
  // Auto-kill is reserved for processes we can prove belong to THIS
  // repo's dev loop: the CommandLine must reference both a script
  // inside this repo's node_modules AND the repo root path. That admits
  // both the dev electron (electron.exe under node_modules/electron)
  // and the sibling webpack-dev-server (node.exe spawned with
  // node_modules/.bin/webpack.js); it excludes the installed CCSM (in
  // Program Files / AppData with no repo path in its CommandLine).
  //
  // We deliberately do NOT use ExecutablePath as the discriminator:
  // webpack-dev-server runs via the system node.exe in
  // C:\Program Files\nodejs, which would false-negative.
  const lcCmd = (info?.commandLine || '').toLowerCase();
  const lcRepo = repoRoot.toLowerCase();
  const lcRepoNm = `${lcRepo}\\node_modules`.toLowerCase();
  const looksLikeOurDev =
    info && lcCmd.includes(lcRepoNm);

  if (looksLikeOurDev) {
    console.error(
      `[dev-electron] port 4100 held by zombie dev electron PID=${holderPid} (path matches this repo). Killing.`,
    );
    spawnSync('taskkill', ['/F', '/T', '/PID', String(holderPid)]);
    return;
  }

  console.error(
    `\n[dev-electron] port 4100 is in use by PID=${holderPid}, ` +
      `and we cannot confirm it's a leftover dev process for THIS repo. ` +
      `Refusing to kill blindly.\n` +
      `  ExecutablePath: ${info?.executablePath ?? '<unknown>'}\n` +
      `  CommandLine:    ${info?.commandLine ?? '<unknown>'}\n\n` +
      `If this is your installed CCSM or another app, leave it alone. ` +
      `If it's truly a stale dev, kill it manually: taskkill /F /PID ${holderPid}\n`,
  );
  process.exit(1);
}

function findListenerPidWin(port) {
  // netstat -ano emits one line per socket. Filter LISTENING on :PORT,
  // last column is PID. We avoid `findstr` to keep the pipeline JS-side.
  const res = spawnSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8' });
  if (res.status !== 0) return null;
  const lines = res.stdout.split(/\r?\n/);
  const needle = `:${port}`;
  for (const line of lines) {
    if (!line.includes('LISTENING')) continue;
    // Local Address column contains "0.0.0.0:4100" or "[::]:4100".
    if (!new RegExp(`${needle.replace('.', '\\.')}\\b`).test(line)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function inspectProcessWin(pid) {
  // wmic is deprecated on Win11 but still present on most systems; if
  // missing we fall back to tasklist (which doesn't give CommandLine).
  // CSV output keeps the comma-in-path case parseable.
  const wmic = spawnSync(
    'wmic',
    ['process', 'where', `ProcessId=${pid}`, 'get', 'ExecutablePath,CommandLine', '/format:list'],
    { encoding: 'utf8' },
  );
  if (wmic.status === 0 && wmic.stdout) {
    const out = wmic.stdout;
    const exe = /ExecutablePath=(.*)/i.exec(out)?.[1]?.trim() ?? '';
    const cmd = /CommandLine=(.*)/i.exec(out)?.[1]?.trim() ?? '';
    if (exe || cmd) return { executablePath: exe, commandLine: cmd };
  }
  // Fallback: at least surface the image name.
  const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
  });
  if (tl.status === 0 && tl.stdout.trim()) {
    return { executablePath: tl.stdout.trim(), commandLine: '' };
  }
  return null;
}

const electronBinary = createRequire(import.meta.url)('electron');

const child = spawn(
  electronBinary,
  [`--user-data-dir=${userDataDir}`, repoRoot],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    env: {
      ...process.env,
      CCSM_E2E_NO_SINGLE_INSTANCE: '1',
      // Mark this process as a dev run so main.ts / createWindow.ts can
      // give it a distinct app name ("CCSM (dev)") and window title
      // ("CCSM [dev]"). See preflight comment 3 above.
      CCSM_DEV: '1',
      // Dev-loop ergonomics (Task #11): closing the main window during
      // `npm run dev` should fully quit the Electron app instead of
      // going production tray-resident, so concurrently's `-k` reaps
      // the sibling `dev:web` (webpack-dev-server on :4100). Without
      // this, closing the window leaves the Electron main proc alive
      // in the tray AND keeps webpack-dev-server holding port 4100 —
      // every restart needed a manual taskkill. Scoped to this wrapper
      // so manual `electron .` runs and e2e probes still get the real
      // close-to-tray choreography. Read by
      // `electron/window/createWindow.ts`.
      CCSM_DEV_QUIT_ON_CLOSE: '1',
    },
  },
);

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
