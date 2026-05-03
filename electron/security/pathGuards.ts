// Path safety guards extracted from electron/main.ts (Task #730 Phase A1).
//
// Pure deciders/validators with no I/O — they take a path value and return a
// boolean / normalized form. Owning these in a dedicated module makes the
// safety contract independently auditable and trivially unit-testable.
//
// History: previously named `ipcGuards.ts` and also exported `fromMainFrame`
// for v0.2's defense-in-depth on ipcMain.handle callers. Wave 0b (#216)
// purged the v0.2 IPC layer, so the IPC-frame check is gone; what remains is
// the path safety contract. Wave 0d will move this module to the daemon.

import * as path from 'path';
import * as os from 'os';

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

// Expand a leading `~` / `~/` / `~\` to the user's home directory. Used by
// callers that normalize persisted cwds before the safety check.
export function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\'))
    return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}
