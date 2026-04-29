// IPC security guards extracted from electron/main.ts (Task #730 Phase A1).
//
// Pure deciders/validators with no I/O — they take a value (path, IPC event)
// and return a boolean / normalized form. Owning these in a dedicated module
// makes the security contract independently auditable and trivially unit-
// testable, and prevents accidental drift if a future handler forgets to
// re-implement the same checks inline.

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
// `paths:exist` to normalize persisted cwds before the safety check. Inlined
// here after the `electron/agent/sessions.ts` deletion (W3.5c) — it was the
// only non-deleted consumer of the old `resolveCwd` helper.
export function resolveCwd(cwd: string): string {
  if (cwd === '~') return os.homedir();
  if (cwd.startsWith('~/') || cwd.startsWith('~\\'))
    return path.join(os.homedir(), cwd.slice(2));
  return cwd;
}

// Defense-in-depth: every IPC handler that takes a privileged action should
// first confirm the message originated from our top-level renderer frame. A
// compromised iframe (e.g. via a future webview, or a misconfigured CSP)
// can otherwise call into ipcMain with the same `e.sender`. Pairs with the
// `setWindowOpenHandler({ action: 'deny' })` and `will-navigate` blocks
// installed in createWindow().
export function fromMainFrame(e: Electron.IpcMainInvokeEvent): boolean {
  return e.senderFrame === e.sender.mainFrame;
}
