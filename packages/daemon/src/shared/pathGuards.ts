// Daemon-local copy of electron/security/pathGuards.ts. Pure deciders/
// validators with no I/O — they take a path value and return a boolean /
// normalized form.
//
// Why a duplicated copy (Wave 0d.4 / #251): the daemon `rootDir: src`
// forbids reaching into electron/, but ptyHost (now under daemon) needs
// `isSafePath` to gate renderer-supplied cwds before any fs.* call.
// Following the #958 precedent for `shared/sessionState.ts`, we keep one
// canonical copy here for daemon code and leave the electron-side copy
// untouched for electron-only callers (other electron/security/__tests__,
// electron/main.ts indirect consumers). v0.4 unifies via Connect-RPC
// boundary — until then both copies must stay byte-for-byte identical.

import * as path from 'node:path';
import * as os from 'node:os';

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
