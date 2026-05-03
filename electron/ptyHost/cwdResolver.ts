// Pure decider for the cwd handed to `pty.spawn`.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). node-pty
// surfaces an invalid cwd as a hard spawn failure — on Windows this is
// `error code: 267` (ERROR_DIRECTORY) which is not actionable for the user
// and looks like ccsm crashing the CLI. Validate first; if the requested
// path is empty, missing, or not a directory, fall back to the user's home
// directory (always exists by definition for an interactive Electron
// session) and log a warning so the cause is visible in the console.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isSafePath } from '../security/pathGuards';

export function resolveSpawnCwd(requested: string | null | undefined): string {
  const fallback = homedir();
  if (!requested || requested.length === 0) return fallback;
  // Security gate (#804 risk #1): reject UNC / relative / non-string paths
  // BEFORE the statSync. On Windows `statSync('\\\\evil\\share')` triggers
  // an SMB handshake that leaks the user's NTLM hash. The renderer-supplied
  // cwd flows directly here from `pty:spawn`, so this is the only choke
  // point that protects the entire spawn pipeline.
  if (!isSafePath(requested)) {
    console.warn(
      `[ptyHost] cwd ${JSON.stringify(requested)} rejected by isSafePath (UNC / relative); falling back to ${fallback}`,
    );
    return fallback;
  }
  try {
    const st = statSync(requested);
    if (st.isDirectory()) return requested;
    console.warn(
      `[ptyHost] cwd ${JSON.stringify(requested)} is not a directory; falling back to ${fallback}`,
    );
    return fallback;
  } catch (err) {
    console.warn(
      `[ptyHost] cwd ${JSON.stringify(requested)} unusable (${err instanceof Error ? err.message : String(err)}); falling back to ${fallback}`,
    );
    return fallback;
  }
}
