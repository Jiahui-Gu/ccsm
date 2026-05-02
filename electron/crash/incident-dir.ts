// electron/crash/incident-dir.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
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
  return dir;
}

export function writeMeta(dir: string, meta: IncidentMeta): void {
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
}

export function writeReadme(dir: string, summary: string): void {
  fs.writeFileSync(path.join(dir, 'README.txt'), summary, 'utf8');
}
