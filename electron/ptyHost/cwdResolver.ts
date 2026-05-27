// Pure decider for the cwd handed to `pty.spawn`.
//
// Extracted from electron/ptyHost/index.ts (Task #729 Phase A). node-pty
// surfaces an invalid cwd as a hard spawn failure — on Windows this is
// `error code: 267` (ERROR_DIRECTORY) which is not actionable for the user
// and looks like ccsm crashing the CLI. Validate first; if the requested
// path is empty, missing, or not a directory, fall back to the user's home
// directory (always exists by definition for an interactive Electron
// session) and log a warning so the cause is visible in the console.
//
// Empty-cwd hardening (#83, follow-up to PR #1404 reviewer feedback): PR
// #1404 fixed a renderer-side regression where reload spawns dropped the
// current cwd. The actual landing spot for that regression was THIS file —
// the empty-cwd branch silently returned `homedir()` with no log, so the
// resulting "claude spawned in $HOME → trust folder?" prompt was the only
// user-visible signal. We now emit a structured `cwd.empty_fallback` event
// every time empty / null / undefined hits this boundary so future
// regressions of the same shape surface in main's JSONL log instead of
// masquerading as a UX bug. Fallback behavior is unchanged — legit callers
// (e.g. imported JSONLs with no recorded cwd) continue to spawn in homedir.

import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isSafePath } from '../security/ipcGuards';
import { log } from '../shared/log';

export function resolveSpawnCwd(
  requested: string | null | undefined,
  sid?: string,
): string {
  const fallback = homedir();
  if (requested === undefined) {
    log.event('cwd.empty_fallback', { sid, reason: 'undefined' });
    return fallback;
  }
  if (requested === null) {
    log.event('cwd.empty_fallback', { sid, reason: 'null' });
    return fallback;
  }
  if (requested.length === 0) {
    log.event('cwd.empty_fallback', { sid, reason: 'empty' });
    return fallback;
  }
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
