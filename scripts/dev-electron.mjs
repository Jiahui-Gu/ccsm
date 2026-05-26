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
  // Auto-kill is reserved for a LEFTOVER ELECTRON from a previous dev
  // loop of THIS repo. Two conditions must both hold:
  //   (a) CommandLine references this repo's node_modules — proves it
  //       belongs to this checkout, not the installed CCSM or some
  //       other project.
  //   (b) The process is electron itself — proves it's the one we want
  //       to replace, not the sibling webpack-dev-server (node.exe
  //       running webpack.js) that concurrently just spawned this run.
  //
  // The earlier version of this check only required (a), which falsely
  // matched the in-flight dev:web and killed it on startup. See task
  // #67 for the incident. ExecutablePath is reliable for electron
  // because the dev wrapper invokes node_modules\electron\dist\electron.exe
  // directly.
  const lcCmd = (info?.commandLine || '').toLowerCase();
  const lcExe = (info?.executablePath || '').toLowerCase();
  const lcRepo = repoRoot.toLowerCase();
  const lcRepoNm = `${lcRepo}\\node_modules`.toLowerCase();
  // The holder we want to auto-kill is a LEFTOVER ELECTRON from a prior
  // dev run — not the sibling webpack-dev-server we just spawned this
  // run (which also lives under <repo>\node_modules). Discriminate on
  // electron-ness: exe path contains "\electron\" OR cmdline points at
  // node_modules\electron\... . webpack is node.exe with a webpack.js
  // cmdline — both checks exclude it.
  const looksLikeElectron =
    lcExe.includes('\\electron\\') ||
    lcExe.endsWith('\\electron.exe') ||
    lcCmd.includes('\\node_modules\\electron\\');
  const looksLikeOurDev =
    info && lcCmd.includes(lcRepoNm) && looksLikeElectron;

  if (looksLikeOurDev) {
    console.error(
      `[dev-electron] port 4100 held by zombie dev electron PID=${holderPid} (path matches this repo). Killing.`,
    );
    spawnSync('taskkill', ['/F', '/T', '/PID', String(holderPid)]);
    return;
  }

  // Sibling webpack-dev-server (this repo's node_modules, cmdline
  // contains "webpack" — node.exe running webpack.js). That's the
  // expected occupant of :4100 when `npm run dev` is in flight via
  // concurrently. Don't kill it, don't bail — let electron start.
  const looksLikeOurWebpack =
    info && lcCmd.includes(lcRepoNm) && lcCmd.includes('webpack');
  if (looksLikeOurWebpack) return;

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
  // `:4100 ` (with trailing whitespace) discriminates the exact port
  // from substrings like `:41000`. netstat always pads the local
  // address column with at least one space before the foreign address.
  const needle = `:${port} `;
  for (const line of lines) {
    if (!line.includes('LISTENING')) continue;
    if (!line.includes(needle)) continue;
    const cols = line.trim().split(/\s+/);
    const pid = Number(cols[cols.length - 1]);
    if (Number.isFinite(pid) && pid > 0) return pid;
  }
  return null;
}

function inspectProcessWin(pid) {
  // Try wmic first — fastest and present on Win10 + most Win11 < 24H2.
  // Win11 24H2 removed wmic by default; CIM via PowerShell is the
  // documented replacement and ships on every supported Win10/11 SKU.
  // Final fallback is tasklist for the image name only.
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

  // PowerShell CIM fallback. ConvertTo-Json keeps quoted strings
  // unambiguous (Format-List loses newlines inside CommandLine for
  // some processes). -NoProfile skips user $PROFILE so this is safe
  // and fast in fresh shells. Property selection is explicit so the
  // JSON shape doesn't depend on PowerShell version.
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
  if (ps.status === 0 && ps.stdout.trim()) {
    try {
      const obj = JSON.parse(ps.stdout);
      const exe = String(obj?.ExecutablePath ?? '').trim();
      const cmd = String(obj?.CommandLine ?? '').trim();
      if (exe || cmd) return { executablePath: exe, commandLine: cmd };
    } catch {
      /* fall through to tasklist */
    }
  }

  // Final fallback: tasklist gives us the image name only (no
  // CommandLine). With empty commandLine, the preflight rule
  // `looksLikeOurDev` is guaranteed false → refuse to kill, which
  // is the safe default. Parse the first CSV field so the bail
  // message shows just `CCSM.exe`, not the raw 5-column row.
  const tl = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
  });
  if (tl.status === 0 && tl.stdout.trim()) {
    const firstField = /^"([^"]*)"/.exec(tl.stdout.trim())?.[1] ?? '';
    if (firstField) return { executablePath: firstField, commandLine: '' };
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
