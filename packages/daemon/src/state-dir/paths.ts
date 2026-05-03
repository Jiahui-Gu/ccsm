// Per-OS daemon state directory layout — frozen constants per spec
// `2026-05-03-v03-daemon-split-design.md` ch07 §2 (state directory layout per
// OS) and §2.1 (descriptor file lifecycle).
//
// The daemon owns all state. Paths are LOCKED unconditionally per OS — no
// per-install variation, no XDG override on linux (the daemon runs as a
// system service and may have no logged-in user). See ch07 §2 table.
//
// T5.3 scope:
//   - Frozen per-OS root + subpath constants exposed via `statePaths()`.
//   - `ensureStateDir()` mkdir -p with the spec-mandated mode (0700 dirs;
//     descriptor file is 0644 per ch07 §2 — written by the descriptor writer
//     in T1.6, NOT here).
//   - Boot-time descriptor lifecycle helpers (`writeDescriptorAtBoot` /
//     `removeDescriptorAtShutdown`) that wrap an injected writer/remover.
//     The writer itself is owned by T1.6 (atomic write + fsync + rename per
//     ch07 §2.1 / ch03 §3); this module accepts injection so the PR doesn't
//     block on T1.6 landing.
//
// Out of scope (separate tasks):
//   - Corrupt-DB recovery → T5.7 (Task #60).
//   - OS service install / register → T7.4 (Task #81).
//   - DACL / ACL setup on win32 / chown/chgrp on linux → installer (ch10 §5).

import { mkdir } from 'node:fs/promises';
import * as path from 'node:path';

/**
 * Per-OS NodeJS platform identifier we recognise. Anything else falls into
 * the linux branch (FHS) so dev runs on freebsd / openbsd / etc. work.
 */
export type StateDirPlatform = NodeJS.Platform;

/** Bundle of the spec ch07 §2 paths for a given OS. All absolute. */
export interface StatePaths {
  /** Durable state root (ch07 §2 — `Daemon state root` column). */
  readonly root: string;
  /** Listener-A descriptor file (ch07 §2 / ch03 §3). */
  readonly descriptor: string;
  /**
   * Descriptors dir — reserved for additional descriptor files (e.g.
   * `listener-b.json` in v0.4 per ch03 §6). v0.3 only writes
   * `listener-a.json` directly under `root`, but mkdir-ing the dir now is
   * cheap and means the path is stable.
   */
  readonly descriptorsDir: string;
  /** SQLite database file (ch07 §2 — DB path column / §3 schema). */
  readonly sessionsDb: string;
  /** Crash collector raw NDJSON file (ch07 §2 / ch09). */
  readonly crashRaw: string;
}

/**
 * Mode bits applied to directories created by `ensureStateDir` on
 * POSIX (mkdir mode is ignored on win32 — DACLs are set by the installer
 * per ch10 §5). 0o700 matches ch07 §2 ("All paths created with mode `0700`
 * for the daemon's service account").
 */
export const STATE_DIR_MODE = 0o700;

/**
 * Compute frozen state paths for a given platform + env snapshot. Pure: no
 * filesystem I/O, no `process.env` reads other than the explicit `env`
 * argument. Pass `process.env` from the caller so the function is trivially
 * testable per OS branch.
 *
 * Spec ch07 §2 table:
 *   - win32:  `%PROGRAMDATA%\ccsm`  (fallback `C:\ProgramData\ccsm`)
 *   - darwin: `/Library/Application Support/ccsm`
 *   - linux/other: `/var/lib/ccsm`
 */
export function statePaths(
  platform: StateDirPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): StatePaths {
  const root = stateRoot(platform, env);
  // Use platform-correct join so win32 uses `\` and POSIX uses `/`. Tests
  // assert posix-style on linux/darwin and either `\` or `/` on win32.
  const join = platform === 'win32' ? path.win32.join : path.posix.join;
  return Object.freeze({
    root,
    descriptor: join(root, 'listener-a.json'),
    descriptorsDir: join(root, 'descriptors'),
    sessionsDb: join(root, 'sessions.db'),
    crashRaw: join(root, 'crash-raw.ndjson'),
  });
}

function stateRoot(platform: StateDirPlatform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    // %PROGRAMDATA% is set on every modern Windows. Fall back to the
    // documented default (`C:\ProgramData`) so dev runs on a stripped env
    // still work. NEVER %LOCALAPPDATA% / %APPDATA% per ch07 §2 (locked).
    const programData = env.PROGRAMDATA && env.PROGRAMDATA.length > 0
      ? env.PROGRAMDATA
      : 'C:\\ProgramData';
    return path.win32.join(programData, 'ccsm');
  }
  if (platform === 'darwin') {
    // System-wide; NEVER `~/Library/...` per ch07 §2.
    return '/Library/Application Support/ccsm';
  }
  // linux + every other POSIX. FHS-correct; do NOT respect XDG_DATA_HOME
  // here — see ch07 §2 ("the daemon may run with no logged-in user").
  return '/var/lib/ccsm';
}

/**
 * mkdir -p the state root + the descriptors subdir with the spec-mandated
 * mode. Idempotent — safe to call on every daemon boot.
 *
 * On win32 the mode is ignored by the OS (DACLs are set by the installer
 * per ch10 §5 / ch07 §2). We still pass it for consistency.
 *
 * Returns the resolved StatePaths so callers can chain
 * `const paths = await ensureStateDir(); openDb(paths.sessionsDb);`.
 */
export async function ensureStateDir(
  platform: StateDirPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<StatePaths> {
  const paths = statePaths(platform, env);
  await mkdir(paths.root, { recursive: true, mode: STATE_DIR_MODE });
  await mkdir(paths.descriptorsDir, { recursive: true, mode: STATE_DIR_MODE });
  return paths;
}

/**
 * Descriptor writer signature — the actual atomic-write implementation
 * (write `.tmp` → fsync → rename) lives in T1.6. We accept it as injection
 * so this PR doesn't depend on T1.6 landing.
 *
 * Implementations MUST honour ch07 §2.1: write exactly once per daemon boot,
 * atomically, BEFORE Supervisor `/healthz` flips to 200.
 */
export type DescriptorWriter = (descriptorPath: string) => Promise<void>;

/**
 * Descriptor remover signature. Per ch07 §2.1 the file is **left in place**
 * on clean shutdown (orphan files between boots are normal — Electron's
 * `boot_id` mismatch handles them). This hook exists for tests / forced
 * uninstall, NOT for the steady-state shutdown path.
 */
export type DescriptorRemover = (descriptorPath: string) => Promise<void>;

/**
 * Boot-time descriptor write helper. Calls the injected writer with the
 * spec-correct descriptor path for the current OS. Returns the path so the
 * caller can log it.
 *
 * Per ch07 §2.1: writer MUST perform an atomic write (tmp + fsync + rename)
 * and MUST be called BEFORE Supervisor `/healthz` flips to 200. This helper
 * does NOT enforce ordering — `lifecycle.advanceTo(STARTING_LISTENERS)` is
 * the gate. We just route the path.
 */
export async function writeDescriptorAtBoot(
  writer: DescriptorWriter,
  platform: StateDirPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { descriptor } = statePaths(platform, env);
  await writer(descriptor);
  return descriptor;
}

/**
 * Shutdown-time descriptor remover. Per ch07 §2.1 this is **NOT** called on
 * normal clean shutdown (orphan files are intentional). Kept as a named
 * export for: (a) integration tests that need to clean up between runs,
 * (b) installer uninstall path (ch10 §5), (c) explicit operator action.
 *
 * If `remover` is omitted, this is a no-op — matching the spec's "left in
 * place" default behaviour.
 */
export async function removeDescriptorAtShutdown(
  remover?: DescriptorRemover,
  platform: StateDirPlatform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (!remover) return;
  const { descriptor } = statePaths(platform, env);
  await remover(descriptor);
}
