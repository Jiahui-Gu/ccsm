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

export function resolveSpawnCwd(requested: string | null | undefined): string {
  const fallback = homedir();
  if (!requested || requested.length === 0) return fallback;
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
