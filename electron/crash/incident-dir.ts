// electron/crash/incident-dir.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';
import { ulid } from 'ulid';

export interface IncidentMeta {
  schemaVersion: 1;
  incidentId: string;
  ts: string;
  surface: 'main' | 'renderer' | 'gpu' | 'helper' | 'daemon-exit' | 'daemon-uncaught' | 'daemon-boot-crash';
  appVersion: string;
  electronVersion: string;
  os: { platform: string; release: string; arch: string };
  frontend?: { lastSentryEventId?: string; logFile?: string; logRange?: string };
  backend?: {
    exitCode: number | null;
    signal: string | null;
    bootNonce?: string;
    lastTraceId?: string;
    lastHealthzAgoMs: number | null;
    markerPresent: boolean;
  };
}

/**
 * Options for the data-root / crash-root resolvers. Mirrors the daemon-side
 * `PathProvider` shape (`daemon/src/db/ensure-data-dir.ts`) so both processes
 * compute the same path from the same inputs.
 *
 * `env.CCSM_DATA_ROOT`, when set + non-empty, overrides everything: per spec
 * frag-11 §11.6 the data root is per-user, but tests + dogfood need to inject
 * a tmpdir without touching `%LOCALAPPDATA%` / `~/Library/...`.
 */
export interface DataRootProvider {
  platform?: NodeJS.Platform;
  home?: string;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Resolve the OS-native v0.3 data root per frag-11 §11.6 (manager-locked
 * single source). Lowercase `ccsm`; uppercase `CCSM` is the legacy v0.2 path
 * (frag-8 §8.1) and MUST NOT be reintroduced (Task #58 / Audit 2 F1).
 *
 *   Win  : %LOCALAPPDATA%\ccsm
 *   mac  : ~/Library/Application Support/ccsm
 *   Linux: $XDG_DATA_HOME/ccsm  (when set + absolute)
 *          else ~/.local/share/ccsm
 *
 * Override: when `env.CCSM_DATA_ROOT` is set + non-empty it wins. Tests use
 * this to point all three crash surfaces (electron-main, renderer-forwarded,
 * daemon-via-supervisor-adoption) at the same tmpdir.
 *
 * Pure: no fs access. Mirrors `daemon/src/db/ensure-data-dir.ts`
 * `resolveDataRoot()` so electron + daemon agree on the same path.
 */
export function resolveDataRoot(provider: DataRootProvider = {}): string {
  const platform = provider.platform ?? process.platform;
  const home = provider.home ?? os.homedir();
  const env = provider.env ?? process.env;
  const override = env.CCSM_DATA_ROOT;
  if (override && override.length > 0) return override;
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    const root = local && local.length > 0 ? local : path.join(home, 'AppData', 'Local');
    return path.join(root, 'ccsm');
  }
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'ccsm');
  }
  const xdg = env.XDG_DATA_HOME;
  if (xdg && xdg.length > 0 && (xdg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(xdg))) {
    return path.join(xdg, 'ccsm');
  }
  return path.join(home, '.local', 'share', 'ccsm');
}

/**
 * Single source of truth for the crash-incident root. Spec frag-6-7 §6.6.3
 * (per PR #784 spec consolidation) defines a single per-user
 * `<dataRoot>/crashes/` bucket containing one timestamped sub-directory per
 * incident; the `surface:` field inside `meta.json` discriminates electron-
 * main vs renderer-forwarded vs daemon-adopted crashes (NOT a per-surface
 * subdir split — the surface is metadata, not a path component).
 *
 * Used by:
 *   - `electron/main.ts` (electron-main crashes + render/child-process-gone)
 *   - `electron/ipc/rendererErrorForwarder.ts` (renderer-forwarded reports,
 *     transitively via the collector instance constructed in `main.ts`)
 *   - `electron/daemon/supervisor.ts` `attachCrashCapture` (daemon crashes
 *     adopted into the same bucket, with `<runtimeRoot>/crash/<bootNonce>.json`
 *     marker folded in as `daemon-marker.json`)
 *
 * The historical `localAppData` parameter is preserved as a thin shim so
 * callers from the prior API don't break; new code should pass a full
 * `DataRootProvider` (or omit) instead.
 */
export function resolveCrashRoot(localAppDataOrProvider?: string | DataRootProvider): string {
  if (typeof localAppDataOrProvider === 'string') {
    const env = { ...process.env, LOCALAPPDATA: localAppDataOrProvider };
    return path.join(resolveDataRoot({ env }), 'crashes');
  }
  return path.join(resolveDataRoot(localAppDataOrProvider), 'crashes');
}

function pad(n: number, w = 2): string { return String(n).padStart(w, '0'); }
function tsStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
}

export function createIncidentDir(root: string, id: string = ulid()): string {
  fs.mkdirSync(root, { recursive: true });
  const dir = path.join(root, `${tsStamp()}-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  // Task #131: ensure new incident dir is owner-only (0700 POSIX). Win
  // gets a separate one-shot icacls fix during boot verifyAndFixCrashAcl.
  if (process.platform !== 'win32') {
    try { fs.chmodSync(dir, 0o700); } catch { /* fail-soft */ }
  }
  return dir;
}

export function writeMeta(dir: string, meta: IncidentMeta): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(path.join(dir, 'meta.json'), 0o600); } catch { /* fail-soft */ }
  }
}

export function writeReadme(dir: string, summary: string): void {
  fs.writeFileSync(path.join(dir, 'README.txt'), summary, 'utf8');
  if (process.platform !== 'win32') {
    try { fs.chmodSync(path.join(dir, 'README.txt'), 0o600); } catch { /* fail-soft */ }
  }
}

// ---------------------------------------------------------------------------
// Task #131 — 30-day retention prune + 0600 ACL verify (r3 reliability P1).
// ---------------------------------------------------------------------------

export interface PruneResult {
  removedCount: number;
  keptCount: number;
  /** Oldest mtimeMs among KEPT incidents, or null if root empty after prune. */
  oldestMtime: number | null;
}

export interface PruneIncidentsOpts {
  /** Days to keep. Defaults to 30. */
  maxAgeDays?: number;
  /** For tests: clock injection (defaults to Date.now). */
  now?: () => number;
  /** For tests: optional logger. Defaults to console.warn / console.info. */
  logger?: { warn: (msg: string) => void; info: (msg: string) => void };
}

/**
 * Delete incident sub-directories whose mtime is older than `maxAgeDays`
 * (default 30) under `root`. Fail-soft: any individual error is logged
 * (warn) but does not abort the sweep. Emits a single canonical
 * `crash_prune_complete` info line on completion.
 *
 * Underscore- and dot-prefixed entries (e.g. `_dmp-staging`, `.uploaded`)
 * are skipped so the staging dir + sibling control files survive.
 */
export function pruneIncidents(root: string, opts: PruneIncidentsOpts = {}): PruneResult {
  const maxAgeDays = opts.maxAgeDays ?? 30;
  const now = (opts.now ?? Date.now)();
  const log = opts.logger ?? { warn: (m) => console.warn(m), info: (m) => console.info(m) };
  const cutoff = now - maxAgeDays * 24 * 3600 * 1000;

  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch (err) {
    log.warn(`crash_prune_skip {reason="readdir_failed", root="${root}", err="${(err as Error).message}"}`);
    return { removedCount: 0, keptCount: 0, oldestMtime: null };
  }

  let removedCount = 0;
  let keptCount = 0;
  let oldestMtime: number | null = null;

  for (const name of names) {
    if (name.startsWith('_') || name.startsWith('.')) continue;
    const full = path.join(root, name);
    let stat: fs.Stats;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isDirectory()) continue;
    if (stat.mtimeMs < cutoff) {
      try {
        fs.rmSync(full, { recursive: true, force: true });
        removedCount++;
      } catch (err) {
        log.warn(`crash_prune_rm_failed {path="${full}", err="${(err as Error).message}"}`);
      }
    } else {
      keptCount++;
      if (oldestMtime === null || stat.mtimeMs < oldestMtime) oldestMtime = stat.mtimeMs;
    }
  }

  log.info(`crash_prune_complete {removed_count=${removedCount}, kept_count=${keptCount}, oldest_mtime=${oldestMtime ?? 'null'}}`);
  return { removedCount, keptCount, oldestMtime };
}

export interface PruneScheduleHandle {
  /** Stop the periodic prune timer. Idempotent. */
  stop(): void;
}

export interface SchedulePruneOpts extends PruneIncidentsOpts {
  /** Interval in ms between prunes. Defaults to 24h. */
  intervalMs?: number;
  /** Run an immediate prune at schedule start. Defaults to true. */
  runImmediately?: boolean;
}

/**
 * Boot helper: prune at startup + every `intervalMs` (default 24h).
 * Returned handle's `stop()` clears the timer (call from app `before-quit`
 * if you want a clean shutdown). Each tick is wrapped in try/catch — a
 * fs error never tears down the host process.
 */
export function schedulePruneIncidents(root: string, opts: SchedulePruneOpts = {}): PruneScheduleHandle {
  const intervalMs = opts.intervalMs ?? 24 * 3600 * 1000;
  const runImmediately = opts.runImmediately ?? true;
  const safeRun = (): void => {
    try { pruneIncidents(root, opts); } catch (err) {
      const log = opts.logger ?? { warn: (m: string) => console.warn(m), info: () => {} };
      log.warn(`crash_prune_tick_failed {err="${(err as Error).message}"}`);
    }
  };
  if (runImmediately) safeRun();
  const timer = setInterval(safeRun, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  return { stop: () => clearInterval(timer) };
}

// ---------------------------------------------------------------------------
// 0600 / 0700 ACL verify + fix.
// ---------------------------------------------------------------------------

export interface AclLogger { warn: (msg: string) => void; info: (msg: string) => void }
export interface AclFixDeps {
  /** Override platform for tests. */
  platform?: NodeJS.Platform;
  /** Override icacls runner for tests. Returns true on success. */
  runIcacls?: (target: string, args: string[]) => boolean;
  /** Logger override. */
  logger?: AclLogger;
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** Default Win icacls invocation: grant only the current user, drop inherit. */
function defaultRunIcacls(target: string, args: string[]): boolean {
  const r = spawnSync('icacls', [target, ...args], { stdio: 'ignore', windowsHide: true });
  return r.status === 0;
}

function applyOwnerOnlyWin(target: string, runIcacls: (t: string, a: string[]) => boolean): boolean {
  // Reset inheritance, grant current user full control, remove built-in groups.
  // `%USERNAME%` resolves at spawn time via cmd-style %; we fall back to
  // `${USERNAME}` env if the var is set.
  const user = process.env.USERNAME ?? process.env.USER ?? '';
  if (!user) return false;
  if (!runIcacls(target, ['/inheritance:r'])) return false;
  if (!runIcacls(target, ['/grant:r', `${user}:(OI)(CI)F`])) return false;
  return true;
}

/**
 * Verify that the crash root dir + every incident sub-dir + every file
 * underneath has owner-only ACLs (POSIX 0700 dir / 0600 file; Win
 * inheritance-stripped owner-only DACL via icacls). On mismatch, FIX +
 * emit one canonical `crash_acl_fixed` line per repaired path. Fail-soft:
 * any error is warned but never throws.
 */
export function verifyAndFixCrashAcl(root: string, deps: AclFixDeps = {}): { fixedCount: number; checkedCount: number } {
  const platform = deps.platform ?? process.platform;
  const log = deps.logger ?? { warn: (m: string) => console.warn(m), info: (m: string) => console.info(m) };
  const runIcacls = deps.runIcacls ?? defaultRunIcacls;

  let fixedCount = 0;
  let checkedCount = 0;

  if (!fs.existsSync(root)) return { fixedCount, checkedCount };

  const fixOne = (target: string, isDir: boolean): void => {
    checkedCount++;
    if (platform === 'win32') {
      // We can't cheaply read DACL without native binding; rely on icacls
      // grant being idempotent + log fix once per boot.
      const before = 'unknown';
      const ok = applyOwnerOnlyWin(target, runIcacls);
      if (ok) {
        fixedCount++;
        log.info(`crash_acl_fixed {path="${target}", before="${before}", after="owner-only"}`);
      } else {
        log.warn(`crash_acl_fix_failed {path="${target}"}`);
      }
      return;
    }
    let stat: fs.Stats;
    try { stat = fs.statSync(target); } catch { return; }
    const expected = isDir ? DIR_MODE : FILE_MODE;
    const actual = stat.mode & 0o777;
    if (actual !== expected) {
      try {
        fs.chmodSync(target, expected);
        fixedCount++;
        log.info(`crash_acl_fixed {path="${target}", before="0${actual.toString(8)}", after="0${expected.toString(8)}"}`);
      } catch (err) {
        log.warn(`crash_acl_fix_failed {path="${target}", err="${(err as Error).message}"}`);
      }
    }
  };

  const walk = (dir: string): void => {
    fixOne(dir, true);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) fixOne(full, false);
    }
  };

  walk(root);
  return { fixedCount, checkedCount };
}
