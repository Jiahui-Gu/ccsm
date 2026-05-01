// T34: ensure-data-dir — daemon-side resolution + provisioning of the
// OS-native v0.3 data root, plus boot-time orphan tmp-file cleanup.
//
// Spec refs:
//   - docs/superpowers/specs/v0.3-fragments/frag-8-sqlite-migration.md
//     §8.2 (target location), §8.3 steps 1 + 1a (mkdir + orphan unlink),
//     §8.5 S2 (`<dataRoot>/data/ccsm.db.migrating[-wal][-shm]` orphans),
//     plan delta Task 8a ("implement ensureDataDir(): resolves OS-native
//     <dataRoot> via per-OS resolver: %LOCALAPPDATA%\\ccsm\\ Win,
//     ~/Library/Application Support/ccsm/ mac, ~/.local/share/ccsm/ Linux").
//   - docs/superpowers/specs/v0.3-fragments/frag-11-packaging.md §11.6
//     (canonical per-user data root paths, tied to the installer drop).
//
// Single Responsibility (producer/decider/sink): producer of a small
// `EnsuredDataDir` shape describing the resolved paths AND whether the
// canonical SQLite file is already present (`kind: 'fresh' | 'existing'`).
// The boot orchestrator (frag-8 §8.3 steps 2-6, owned by a separate task)
// uses that signal to fork into "stamp marker / call resolveLegacyDir +
// runMigration / fast-path return". This module does NOT decide migration,
// open the database, acquire the lockfile, or read the migration marker.
//
// Lockfile ordering (round-3 reliability P0-R4): the daemon-singleton
// lockfile (`<dataRoot>/daemon.lock`, owned by frag-6-7 §6.4) MUST be
// acquired by the caller BEFORE calling `ensureDataDir()`. Step 1a's
// unconditional unlink of `ccsm.db.migrating*` is only safe-as-orphan
// when the host has a single live daemon. Callers violating this
// invariant are not the responsibility of this module to police; the
// boot path wiring (Task 8a integration) enforces it.
//
// Purity / no Electron import: the daemon process has no `electron`
// dependency (frag-8 §8.4 first paragraph). The OS-native data root is
// resolved here from `process.platform` + env vars (`LOCALAPPDATA`,
// `XDG_DATA_HOME`, `HOME`) — **NOT** from `app.getPath('userData')`. A
// `pathProvider` parameter lets tests inject a tmpdir without depending
// on the real env.

import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';

/** Tmp-file basenames cleaned in step 1a, per frag-8 §8.5 S2. */
const ORPHAN_TMP_EXTS = ['', '-wal', '-shm'] as const;

/**
 * Outcome of `ensureDataDir()`. Producer-only; the caller decides the
 * boot fork (frag-8 §8.3 steps 2-6).
 *
 * - `kind: 'fresh'` — `<dataRoot>/data/ccsm.db` does NOT exist.
 *   Caller checks the migration marker (step 2) and either returns
 *   fast-path (marker.completed) or proceeds to resolveLegacyDir (step 4).
 * - `kind: 'existing'` — `<dataRoot>/data/ccsm.db` exists.
 *   Caller stamps `{completed: true, reason: 'preexisting'}` per
 *   frag-8 §8.3 step 3 and returns. No probe of the file's contents
 *   is performed here — `quick_check` happens later (frag-8 §8.5 S4)
 *   and only on the legacy source, not on a pre-existing target.
 *
 * `orphansRemoved` is the count of tmp files unlinked in step 1a; useful
 * for the boot path's structured `ensure_data_dir` log line and for
 * tests asserting recovery from a partial migration.
 */
export interface EnsuredDataDir {
  /** OS-native data root, e.g. `%LOCALAPPDATA%\ccsm\`. */
  readonly dataRoot: string;
  /** `<dataRoot>/data` — the SQLite directory. */
  readonly dataDir: string;
  /** `<dataRoot>/data/ccsm.db` — the canonical database file path. */
  readonly dbPath: string;
  /** Whether the database file already exists at `dbPath`. */
  readonly kind: 'fresh' | 'existing';
  /** Number of orphan `ccsm.db.migrating*` files unlinked in step 1a. */
  readonly orphansRemoved: number;
}

/**
 * Pluggable host-state provider so tests can run against a tmpdir without
 * depending on `process.env` / `os.homedir()`. The default implementation
 * (`defaultPathProvider`) reads the real environment.
 *
 * Three signals are sufficient to compute the OS-native data root for
 * all three target platforms:
 *
 * - `platform`: matches `process.platform` ('win32' | 'darwin' | 'linux').
 * - `home`: user profile root — used for mac/Linux fallbacks and as the
 *   Windows fallback when `%LOCALAPPDATA%` is unset (rare, e.g.
 *   stripped-down service-account environments).
 * - `env`: env-var bag. We read `LOCALAPPDATA` (Win) and `XDG_DATA_HOME`
 *   (Linux) per frag-11 §11.6 paths table.
 */
export interface PathProvider {
  readonly platform: NodeJS.Platform;
  readonly home: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}

export function defaultPathProvider(): PathProvider {
  return { platform: process.platform, home: homedir(), env: process.env };
}

/**
 * Resolve the OS-native data root per frag-8 §8.2 + frag-11 §11.6.
 *
 * - Windows: `%LOCALAPPDATA%\ccsm` (fallback `<home>\AppData\Local\ccsm`
 *   when LOCALAPPDATA is unset — matches Electron's own fallback).
 * - macOS:   `<home>/Library/Application Support/ccsm`.
 * - Linux:   `$XDG_DATA_HOME/ccsm` if set and absolute, else
 *            `<home>/.local/share/ccsm` (XDG Base Directory spec).
 * - Other (BSDs, etc.): treated as Linux for forward-compat. ccsm doesn't
 *   ship binaries for these but the daemon module compiles + tests on
 *   them via Node, so a sensible default beats throwing.
 *
 * Pure: no fs access. Exported so the boot orchestrator and migration
 * unit tests can derive the same paths without re-implementing the
 * resolver.
 */
export function resolveDataRoot(provider: PathProvider = defaultPathProvider()): string {
  const { platform, home, env } = provider;
  // Use the path-flavour matching the TARGET platform (not the host
  // platform). When tests inject `platform: 'linux'` from a Win32 host,
  // we still emit POSIX-style separators so the returned string is the
  // path that would actually appear on a Linux daemon.
  const j = platform === 'win32' ? win32.join : posix.join;
  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    const root = localAppData && localAppData.length > 0 ? localAppData : j(home, 'AppData', 'Local');
    return j(root, 'ccsm');
  }
  if (platform === 'darwin') {
    return j(home, 'Library', 'Application Support', 'ccsm');
  }
  // Linux + everything else.
  const xdg = env['XDG_DATA_HOME'];
  if (xdg && xdg.length > 0 && isAbsoluteIsh(xdg)) {
    return j(xdg, 'ccsm');
  }
  return j(home, '.local', 'share', 'ccsm');
}

/**
 * `XDG_DATA_HOME` is only honoured if absolute per the XDG Base Directory
 * spec ("All paths set in these environment variables must be absolute.
 * If an implementation encounters a relative path in any of these
 * variables it should consider the path invalid and ignore it."). We
 * accept POSIX `/...` and Windows-style `X:\...` for cross-platform
 * test convenience.
 */
function isAbsoluteIsh(p: string): boolean {
  if (p.startsWith('/')) return true;
  if (/^[A-Za-z]:[\\/]/.test(p)) return true;
  return false;
}

/**
 * Provision `<dataRoot>/data` (idempotent recursive mkdir) and clean
 * orphan migration tmp files. Returns the resolved paths plus a
 * `kind` signal driven by whether `ccsm.db` already exists.
 *
 * Per frag-8 §8.3:
 *   1.  mkdirSync(<dataRoot>/data, recursive: true)
 *   1a. for ext in ['', '-wal', '-shm']:
 *           unlinkIfExists(<dataRoot>/data/ccsm.db.migrating + ext)
 *
 * On Unix, the data root is created with mode `0o700` (user-only).
 * `mkdirSync({ recursive: true })` only applies the mode to NEW
 * directories — pre-existing dirs keep their existing mode. We do NOT
 * `chmodSync` an existing dir on the boot path: that would silently
 * tighten user-customised perms and is the kind of "destructive
 * recreate" the design principles call out as undesirable. The data dir
 * is created by the installer anyway (frag-11 §11.6), so the mode is
 * already 0700 in the common case.
 *
 * On Windows, the `mode` argument is ignored by the OS; ACLs are owned
 * by the installer (frag-11 §11.6). We don't attempt ACL writes here —
 * that's installer territory.
 *
 * Throws (lets the caller surface a fatal) on:
 *   - mkdir failure (permission denied, ENOSPC, parent unreachable).
 *   - unlink failure for an EXISTING orphan that's not ENOENT (e.g.
 *     EBUSY on Win because another process is holding the migrating
 *     file open — a sign the lockfile invariant was violated).
 *
 * NEVER throws on:
 *   - data dir already existing (idempotent).
 *   - orphan tmp file already absent (`existsSync === false` short-circuit).
 */
export function ensureDataDir(provider: PathProvider = defaultPathProvider()): EnsuredDataDir {
  const dataRoot = resolveDataRoot(provider);
  const dataDir = join(dataRoot, 'data');
  const dbPath = join(dataDir, 'ccsm.db');

  // Step 1: idempotent recursive mkdir. The `mode` is honoured only on
  // newly-created directories under POSIX; Windows ignores it.
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });

  // Step 1a: orphan unlink. Whether or not we just created the dir,
  // there could be tmp files from a prior boot that died between S3
  // and S6 of the migration runner.
  let orphansRemoved = 0;
  const tmpBase = join(dataDir, 'ccsm.db.migrating');
  for (const ext of ORPHAN_TMP_EXTS) {
    const target = tmpBase + ext;
    if (!existsSync(target)) continue;
    unlinkSync(target);
    orphansRemoved += 1;
  }

  // Probe the canonical db file. We treat the file as "existing" when
  // `statSync` succeeds and reports a regular file (zero-byte counts —
  // the `quick_check` validation in frag-8 §8.5 S4 is the source of
  // truth on file integrity, not this probe). Symlinks resolve through
  // `statSync` (vs `lstatSync`); if the resolved target is missing, we
  // treat as fresh — better-sqlite3 would do the same.
  const kind: EnsuredDataDir['kind'] = probeDbFile(dbPath) ? 'existing' : 'fresh';

  return { dataRoot, dataDir, dbPath, kind, orphansRemoved };
}

function probeDbFile(dbPath: string): boolean {
  try {
    const st = statSync(dbPath);
    return st.isFile();
  } catch {
    return false;
  }
}
