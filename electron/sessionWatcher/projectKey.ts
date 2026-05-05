// Wave-2-C COMPAT SHIM — re-export from the canonical home in daemon/.
// This stub exists for the electron/ptyHost/jsonlResolver wave-1 dead
// caller; it is identical to daemon/sessionWatcher/projectKey.ts inlined
// here so the electron tsconfig (which doesn't include daemon/) resolves.
//
// DELETE when W2-B mv's electron/ptyHost into daemon/.

export function cwdToProjectKey(cwd: string): string {
  if (typeof cwd !== 'string' || cwd.length === 0) return '';
  return cwd.replace(/[\\/:]/g, '-');
}
