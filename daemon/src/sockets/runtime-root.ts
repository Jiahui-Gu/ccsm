// Spec: docs/superpowers/specs/v0.3-design.md §3.1.1 (sockets) — `<runtimeRoot>`
// definition (round-9 manager lock + r11 devx P1-4). Single source of truth for
// where control-socket / data-socket / marker / lockfile siblings live.
//
// Per-OS:
//   Linux  : process.env.XDG_RUNTIME_DIR ?? <dataRoot>/run
//            (XDG-compliant tmpfs preferred; falls back to data root if
//             XDG_RUNTIME_DIR is unset/unwritable, e.g. systemd-less containers)
//   macOS  : <dataRoot>/run
//   Windows: <dataRoot>\run  (named pipes use \\.\pipe namespace; the FS
//            directory only holds the marker / lockfile sibling)
//
// `<dataRoot>` (frag-12 r5 lock #2):
//   Win  : %LOCALAPPDATA%\ccsm
//   mac  : ~/Library/Application Support/ccsm
//   Linux: ~/.local/share/ccsm

import { mkdirSync, statSync, accessSync, constants as fsConstants } from 'node:fs';
import { homedir, hostname, userInfo } from 'node:os';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

function resolveDataRoot(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA;
    if (local && local.length > 0) return join(local, 'ccsm');
    // Spec mandates %LOCALAPPDATA%; if missing the env is broken — fall back to
    // ~/AppData/Local/ccsm so the resolver still returns a usable path rather
    // than throwing in code paths that only need a notional anchor.
    return join(homedir(), 'AppData', 'Local', 'ccsm');
  }
  if (platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'ccsm');
  }
  // Linux + every other POSIX
  const xdgData = env.XDG_DATA_HOME;
  if (xdgData && xdgData.length > 0) return join(xdgData, 'ccsm');
  return join(homedir(), '.local', 'share', 'ccsm');
}

function isWritableDir(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isDirectory()) return false;
    accessSync(path, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function mkdirpPrivate(path: string, isWindows: boolean): void {
  // mkdir recursive is idempotent. mode is honored only on POSIX; Windows
  // ACLs are inherited from %LOCALAPPDATA% (per-user already).
  if (isWindows) {
    mkdirSync(path, { recursive: true });
  } else {
    mkdirSync(path, { recursive: true, mode: 0o700 });
  }
}

export interface ResolveRuntimeRootOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  ensure?: boolean;
}

/**
 * Returns the OS-native runtime/socket directory under which the data-socket,
 * control-socket, marker file, and lockfile siblings all live.
 *
 * Idempotent: safe to call repeatedly. When `ensure` is true (default) the
 * directory is created with mode 0o700 on POSIX (Windows inherits per-user
 * %LOCALAPPDATA% ACL).
 */
export function resolveRuntimeRoot(opts: ResolveRuntimeRootOptions = {}): string {
  const platform = opts.platform ?? process.platform;
  const env = opts.env ?? process.env;
  const ensure = opts.ensure ?? true;
  const isWindows = platform === 'win32';

  let runtimeRoot: string;

  if (platform === 'linux') {
    const xdg = env.XDG_RUNTIME_DIR;
    if (xdg && xdg.length > 0 && isWritableDir(xdg)) {
      runtimeRoot = join(xdg, 'ccsm');
    } else {
      runtimeRoot = join(resolveDataRoot(platform, env), 'run');
    }
  } else {
    // darwin + win32 + every other platform: <dataRoot>/run
    runtimeRoot = join(resolveDataRoot(platform, env), 'run');
  }

  if (ensure) {
    mkdirpPrivate(runtimeRoot, isWindows);
  }

  return runtimeRoot;
}

/**
 * 8-hex-char per-user namespace tag for socket / pipe paths.
 *
 * Spec: docs/superpowers/specs/v0.3-design.md L267 + L272 and
 *       frag-3.4.1-envelope-hardening.md L237 mandate `\\.\pipe\ccsm-data-<userhash>`
 *       on Windows so multi-user hosts (Citrix / RDS / shared workstations)
 *       cannot collide on bind. Without the suffix, an unprivileged second
 *       user could win the bind race against the daemon, leaving the
 *       §3.4.1.g HMAC handshake as the only imposter defense.
 *
 * Definition (production):
 *     lowercase first 8 hex chars of SHA-256(`<username>@<hostname>`).
 * Definition (dev mode, `CCSM_DAEMON_DEV=1` in env):
 *     lowercase first 8 hex chars of SHA-256(`<username>@<hostname>#<cwd>`).
 *     This isolates the named-pipe / socket path per git worktree so two
 *     concurrent dev daemons (e.g. running from `~/ccsm-worktrees/pool-3`
 *     and `~/ccsm-worktrees/pool-5`) do NOT collide on bind. Production
 *     installer flow keeps the canonical `username@hostname` shape so
 *     re-opening the packaged Electron app continues to attach to the
 *     surviving daemon (frag-6-7 §6.1 dogfood metric #1).
 *
 * Pure / deterministic / no I/O. Same inputs always yield the same value;
 * distinct inputs yield (overwhelmingly) distinct values.
 *
 * Sibling helper to `resolveRuntimeRoot()` so T14 (control-socket) and T15
 * (data-socket) can share a single source of truth.
 */
export function userHash(
  opts: {
    username?: string;
    host?: string;
    cwd?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): string {
  const username = opts.username ?? userInfo().username;
  const host = opts.host ?? hostname();
  const env = opts.env ?? process.env;
  const devMode = env.CCSM_DAEMON_DEV === '1';
  const seed = devMode
    ? `${username}@${host}#${opts.cwd ?? process.cwd()}`
    : `${username}@${host}`;
  const digest = createHash('sha256').update(seed).digest('hex');
  return digest.slice(0, 8).toLowerCase();
}
