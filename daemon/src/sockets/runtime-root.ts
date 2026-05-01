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
import { homedir } from 'node:os';
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
