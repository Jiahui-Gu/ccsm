// Path-safety gate shared by the renderer-facing IPC surface in main and the
// daemon's pty spawn path. The only remaining export after the v0.3 wave-2
// cleanup (Task #580) is `isSafePath` — `resolveCwd` and `fromMainFrame` had
// no production callers once electron/__legacy_to_delete__ was removed.
//
// Kept under electron/security/ (rather than relocated to daemon/) because
// tsconfig.daemon.json already include-pulls this single file for
// `daemon/ptyHost/cwdResolver.ts` (W2-B). Moving it would force a churn in
// that path + the daemon tsconfig include list with zero functional gain.
//
// File / module name retained for git history continuity even though
// "ipcGuards" no longer reflects its sole consumer (the daemon spawn path).

import * as path from 'path';

// Filter renderer-supplied filesystem paths before any `fs.*` call. UNC paths
// (`\\server\share\...` or `//server/share/...`) MUST be rejected on Windows:
// node's fs will dutifully reach out over SMB to fetch the file, and on
// Windows that handshake leaks the user's NTLM hash to whatever host the
// renderer named. (CRITICAL — even a single innocuous-looking `existsSync`
// call against a chosen UNC target is a credential-leak primitive.)
//
// We also require absolute paths because every renderer caller already
// passes absolute paths (cwds, persisted disk locations, etc.); a relative
// path here is always a sign of a confused or malicious caller.
export function isSafePath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    path.isAbsolute(p) &&
    !p.startsWith('\\\\') &&
    !p.startsWith('//')
  );
}
