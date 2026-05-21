// Resolve the user's `claude` CLI to an absolute path so ttyd doesn't
// depend on inheriting PATH (Electron's child env can drift from the
// user's shell on Windows: GUI launches inherit the SYSTEM env, not the
// user's interactive profile, and `claude` is typically installed under
// `%APPDATA%\npm` which lives in the user PATH only).
//
// Resolution strategy on Windows:
//   1. `where claude.cmd` — npm-shim shape used by `npm i -g
//      @anthropic-ai/claude-code`. ttyd needs an .exe-or-batch target;
//      the .cmd shim chains into node + the JS entrypoint correctly.
//   2. `where claude` — falls back to a non-shim install (rare on Windows
//      but matches the spike's behavior).
//
// On macOS/Linux: `which claude` (single lookup is enough — no .cmd vs
// bare-name distinction).
//
// Returns null if neither lookup succeeds; callers should surface a
// "claude not on PATH" error to the user. The spike returns the literal
// string 'claude' as a fallback, but that just defers the failure to
// ttyd's spawn, which is harder to diagnose. We prefer an explicit null
// so the IPC channel can return `{available:false}` and the renderer can
// show actionable copy.
//
// Result is cached after the first successful lookup. The user can re-
// install claude or change PATH while ccsm runs; pass `{force: true}` to
// bypass the cache (the renderer's "Re-check" button on ClaudeMissingGuide
// uses this so the user can install claude in a separate terminal and
// recover in-place without restarting the app).
//
// Async since #PERF: the original `spawnSync` blocked the main process
// event loop for 50-200ms on Windows during cold start (first
// `pty:checkClaudeAvailable` from App.tsx + first `pty:spawn`), causing
// a visible "window hang" stutter. Both callers are `ipcMain.handle`
// handlers that already await Promise returns, so flipping to async is
// free at the call site. A module-level in-flight Promise dedups
// concurrent first-callers so two simultaneous IPCs don't double-spawn
// `where`.

import { spawn } from 'node:child_process';

let cached: string | null | undefined; // undefined = never tried
let inFlight: Promise<string | null> | null = null;

// Hard cap on a single `where`/`which` invocation. A broken PATH, slow
// shell startup, or AV interception can hang the lookup indefinitely;
// without a timeout the whole resolveClaude promise never settles and
// the IPC handler stays pending forever (renderer spinner stuck).
const WHERE_TIMEOUT_MS = 5000;

// Exported for the timeout unit test (asserts the rejection shape). Not
// part of the module's public API — production callers go through
// `resolveClaude`.
export function whereAsync(name: string): Promise<string | null> {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return new Promise((resolve, reject) => {
    let stdout = '';
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, [name], { windowsHide: true });
    } catch {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      reject(new Error(`where_timeout: '${cmd} ${name}' did not complete in ${WHERE_TIMEOUT_MS}ms`));
    }, WHERE_TIMEOUT_MS);
    child.stdout?.on('data', (b: Buffer) => {
      stdout += b.toString('utf8');
    });
    child.on('error', () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        resolve(null);
        return;
      }
      const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
      resolve(first ? first.trim() : null);
    });
  });
}

async function doResolve(): Promise<string | null> {
  // Catch where_timeout at the boundary: collapse to null so the IPC
  // contract stays the same (renderer surfaces ClaudeMissingGuide rather
  // than seeing an unhandled rejection / silent fallback to undefined
  // cwd). The warning lets diagnosis trace a hang back to a stuck
  // `where`/`which` rather than a "claude not installed" misdiagnosis.
  try {
    if (process.platform === 'win32') {
      return (await whereAsync('claude.cmd')) ?? (await whereAsync('claude'));
    }
    return await whereAsync('claude');
  } catch (err) {
    console.warn('[claudeResolver]', (err as Error).message);
    return null;
  }
}

export function resolveClaude({ force = false }: { force?: boolean } = {}): Promise<string | null> {
  if (!force && cached !== undefined) return Promise.resolve(cached);
  // Concurrent-caller dedup: while the first lookup is in flight, hand
  // the same Promise to every additional caller. Without this, an N-wide
  // burst of `pty:checkClaudeAvailable` + `pty:spawn` on cold start
  // would spawn N copies of `where` instead of one.
  if (!force && inFlight) return inFlight;
  inFlight = doResolve()
    .then((result) => {
      cached = result;
      return result;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

// Test seam — used by harness-real-cli's ttyd cases to force a fresh
// lookup between cases. Production code never invokes this.
export function __resetClaudeResolverForTest(): void {
  cached = undefined;
  inFlight = null;
}
