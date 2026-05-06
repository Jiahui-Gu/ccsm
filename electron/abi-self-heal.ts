// ABI self-heal — Task #641 Layer 3.
//
// Background: better-sqlite3 ships a native `.node` binding compiled
// against a specific Node ABI (NODE_MODULE_VERSION). When a developer
// runs plain `npm install`, npm picks up better-sqlite3's prebuilt
// binding for the host Node ABI (e.g. v127 on Node 22), NOT the
// Electron ABI (e.g. v145 on Electron 41). The postinstall hook
// (scripts/postinstall.mjs) tries to rebuild via @electron/rebuild
// — but if that fails (toolchain missing, .node locked, etc.) we
// can ship a broken environment.
//
// At runtime the daemon (which lives in the Electron process tree
// post wave-1) tries to `require('better-sqlite3')` and gets a
// classic:
//
//     Error: The module '...\better_sqlite3.node' was compiled
//     against a different Node.js version using NODE_MODULE_VERSION
//     127. This version of Node.js requires NODE_MODULE_VERSION 145.
//
// daemon initDb fails, and pre-Task #641/#639 the user only saw a
// silent storage failure. Layer 1 (#639) surfaces a banner; this
// Layer 3 module makes the failure self-correct: detect the ABI
// mismatch at main entry, run @electron/rebuild as a child process,
// and restart the app once.
//
// Reference: https://www.electronjs.org/docs/latest/tutorial/using-native-node-modules
//
// Design constraints:
//   - Pure / testable: I/O is injected via a `deps` parameter so unit
//     tests can drive every branch without spawning subprocesses.
//   - One-shot: a marker file under userData prevents an infinite
//     rebuild→restart loop if the rebuild itself doesn't fix things
//     (e.g. native toolchain truly missing).
//   - Dev-only opt-in: in packaged builds the postinstall + ship-time
//     pipeline is supposed to leave correct ABI on disk; the self-heal
//     is primarily a dev-machine safety net. Packaged builds still run
//     it because a user upgrading Electron via auto-update can also
//     hit ABI skew (rare; still worth covering).

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

/** Result of a single self-heal attempt; consumed by the caller in main.ts. */
export type SelfHealResult =
  | { kind: 'ok' }                              // native loads cleanly, nothing to do
  | { kind: 'healed'; restartHint: 'app.relaunch' } // rebuilt successfully, caller should relaunch
  | { kind: 'already-tried'; lastError: string }   // marker present, don't loop
  | { kind: 'rebuild-failed'; error: string };  // tried rebuild, still broken

/** Injected dependencies — keeps the function pure-testable. */
export interface SelfHealDeps {
  /** Path to a directory we can write a one-shot marker into (typically `app.getPath('userData')`). */
  userDataDir: string;
  /** Repo or app root containing `node_modules/.bin/electron-rebuild`. */
  appRoot: string;
  /** True on packaged builds — used only for logging context. */
  isPackaged: boolean;
  /** `process.platform`-style; injected for testability. */
  platform: NodeJS.Platform;
  /**
   * Try `require('better-sqlite3')` and exercise it with a `:memory:`
   * open + close. Returns null on success, the Error on failure. The
   * caller wires this to the real `require` in main.ts; tests pass a
   * stub.
   */
  probeBetterSqlite3: () => Error | null;
  /**
   * Run `@electron/rebuild` for better-sqlite3. Returns exit code +
   * stderr tail for diagnostics. Tests stub this.
   */
  runRebuild: (rebuildBin: string, cwd: string) => { status: number; stderrTail: string };
  /** fs override (keeps tests hermetic — defaults to `node:fs`). */
  fs?: Pick<typeof fs, 'existsSync' | 'mkdirSync' | 'readFileSync' | 'writeFileSync' | 'unlinkSync'>;
  /** Logger. Defaults to console. */
  log?: (msg: string) => void;
}

const MARKER_FILENAME = 'abi-self-heal-attempted.json';

/**
 * Build the marker path. Public so main.ts can clear it on a
 * successful daemon initDb (proving the rebuild worked).
 */
export function selfHealMarkerPath(userDataDir: string): string {
  return path.join(userDataDir, MARKER_FILENAME);
}

/**
 * Detect the classic `NODE_MODULE_VERSION ... mismatch` error string. We
 * deliberately match on the Node-emitted phrase rather than the error
 * `code` because better-sqlite3 wraps the original error with no `code`
 * preserved.
 */
export function isAbiMismatchError(err: Error | null | undefined): boolean {
  if (!err) return false;
  const msg = `${err.message ?? ''}\n${err.stack ?? ''}`;
  return /NODE_MODULE_VERSION/i.test(msg) && /different.*version|requires NODE_MODULE_VERSION/i.test(msg);
}

/**
 * Run the self-heal protocol. See SelfHealResult for the four outcomes
 * the caller has to handle.
 *
 * IMPORTANT: this function is synchronous — main.ts calls it before
 * `app.whenReady()` so the rebuild + restart can complete before any
 * BrowserWindow / daemon-spawner code runs. The rebuild subprocess is
 * spawned via `spawnSync` for the same reason.
 */
export function runAbiSelfHeal(deps: SelfHealDeps): SelfHealResult {
  const fsMod = deps.fs ?? fs;
  const log = deps.log ?? ((msg) => console.log(`[abi-self-heal] ${msg}`));
  const isWindows = deps.platform === 'win32';

  // Step 1: probe.
  const probeError = deps.probeBetterSqlite3();
  if (!probeError) {
    // Healthy — also clear any stale marker so a future skew can self-heal again.
    try {
      const marker = selfHealMarkerPath(deps.userDataDir);
      if (fsMod.existsSync(marker)) fsMod.unlinkSync(marker);
    } catch {
      /* swallow — best-effort cleanup */
    }
    return { kind: 'ok' };
  }

  // Step 2: classify. Non-ABI errors are NOT our problem (e.g. native
  // module physically missing → after-pack hook should have caught it
  // at build time). Bubble out so the daemon-init banner from #639
  // surfaces the real story.
  if (!isAbiMismatchError(probeError)) {
    log(`probe failed but not an ABI mismatch — leaving for #639 banner: ${probeError.message}`);
    return { kind: 'rebuild-failed', error: probeError.message };
  }

  log(`detected ABI mismatch: ${probeError.message}`);

  // Step 3: one-shot guard. If we already tried last launch, don't loop;
  // surface the marker so the L1/L2 banners (#639) can tell the user.
  const marker = selfHealMarkerPath(deps.userDataDir);
  if (fsMod.existsSync(marker)) {
    let lastError = '<unknown>';
    try {
      const raw = fsMod.readFileSync(marker, 'utf8');
      const parsed = JSON.parse(raw) as { error?: string };
      if (typeof parsed.error === 'string') lastError = parsed.error;
    } catch {
      /* ignore parse errors — marker presence alone is the signal */
    }
    log(`marker present at ${marker}; refusing to loop. Last error: ${lastError}`);
    return { kind: 'already-tried', lastError };
  }

  // Step 4: locate electron-rebuild bin. Dev install ships it under
  // node_modules/.bin; packaged install does NOT (devDeps stripped),
  // so self-heal degrades to "report only" in production.
  const rebuildBinName = isWindows ? 'electron-rebuild.cmd' : 'electron-rebuild';
  const rebuildBin = path.join(deps.appRoot, 'node_modules', '.bin', rebuildBinName);
  if (!fsMod.existsSync(rebuildBin)) {
    const reason = `@electron/rebuild not available at ${rebuildBin} (likely a packaged build with devDeps stripped); cannot self-heal`;
    log(reason);
    // Write the marker so we don't try-and-fail on every launch.
    try {
      fsMod.mkdirSync(deps.userDataDir, { recursive: true });
      fsMod.writeFileSync(marker, JSON.stringify({ error: reason, ts: Date.now() }, null, 2));
    } catch {
      /* swallow */
    }
    return { kind: 'rebuild-failed', error: reason };
  }

  // Step 5: rebuild. Write the marker BEFORE the rebuild so that even a
  // crash mid-rebuild doesn't put us into a rebuild loop on next launch.
  try {
    fsMod.mkdirSync(deps.userDataDir, { recursive: true });
    fsMod.writeFileSync(
      marker,
      JSON.stringify({ error: probeError.message, ts: Date.now(), phase: 'started' }, null, 2),
    );
  } catch (err) {
    log(`failed to write marker — proceeding anyway: ${(err as Error).message}`);
  }

  log(`running @electron/rebuild for better-sqlite3 (this may take ~30s)...`);
  const result = deps.runRebuild(rebuildBin, deps.appRoot);
  if (result.status !== 0) {
    const errMsg = `@electron/rebuild exited with code ${result.status}. stderr tail: ${result.stderrTail}`;
    log(errMsg);
    try {
      fsMod.writeFileSync(
        marker,
        JSON.stringify({ error: errMsg, ts: Date.now(), phase: 'rebuild-failed' }, null, 2),
      );
    } catch { /* swallow */ }
    return { kind: 'rebuild-failed', error: errMsg };
  }

  log(`rebuild OK — caller should relaunch the app to load the new binding`);
  return { kind: 'healed', restartHint: 'app.relaunch' };
}

/**
 * Default `runRebuild` implementation. Pulled out for `runAbiSelfHeal`
 * default-deps in main.ts. Kept here so tests covering the full deps
 * shape compile against the same function signature.
 */
export function defaultRunRebuild(
  rebuildBin: string,
  cwd: string,
): { status: number; stderrTail: string } {
  const isWindows = process.platform === 'win32';
  const result = spawnSync(
    rebuildBin,
    ['-f', '-o', 'better-sqlite3', '--build-from-source'],
    { stdio: ['ignore', 'inherit', 'pipe'], shell: isWindows, cwd },
  );
  const stderr = (result.stderr ? result.stderr.toString('utf8') : '').trim();
  // Cap to last ~2 KB so logs don't explode.
  const stderrTail = stderr.length > 2048 ? stderr.slice(-2048) : stderr;
  if (result.error) {
    return { status: -1, stderrTail: `${result.error.message}\n${stderrTail}` };
  }
  return { status: typeof result.status === 'number' ? result.status : -1, stderrTail };
}

/**
 * Default `probeBetterSqlite3` implementation: open an in-memory DB and
 * close it. `:memory:` opens are cheap (no fs touch) but exercise the
 * full bindings load + sqlite VFS init path, which is exactly where the
 * ABI mismatch surfaces.
 */
export function defaultProbeBetterSqlite3(): Error | null {
  try {
    /* eslint-disable @typescript-eslint/no-require-imports */
    const Database = require('better-sqlite3') as new (path: string, opts?: { readonly?: boolean }) => {
      close: () => void;
    };
    /* eslint-enable @typescript-eslint/no-require-imports */
    const db = new Database(':memory:');
    db.close();
    return null;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}
