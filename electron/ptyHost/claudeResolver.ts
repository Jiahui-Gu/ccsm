// Resolve the user's `claude` CLI to an absolute path so ttyd doesn't
// depend on inheriting PATH (Electron's child env can drift from the
// user's shell on Windows: GUI launches inherit the SYSTEM env, not the
// user's interactive profile, and `claude` is typically installed under
// `%APPDATA%\npm` which lives in the user PATH only).
//
// Resolution strategy on Windows:
//   1. `where claude.exe` — native/standalone installs (e.g. the winget
//      package, or Anthropic's native installer) put a real Win32
//      executable on PATH. Tried first because it's self-contained: unlike
//      the .cmd shim below, there's no separate "target" file that can go
//      missing out from under it.
//   2. `where claude.cmd` — npm-shim shape used by `npm i -g
//      @anthropic-ai/claude-code`. The shim FILE itself can exist on PATH
//      (so `where` succeeds) even when its target
//      `...\@anthropic-ai\claude-code\bin\claude.exe` has been removed —
//      e.g. a stale/partial global npm install left behind after
//      switching to a native install. Spawning a broken shim fails at
//      ttyd's spawn time with an opaque "...claude.exe is not recognized
//      as an internal or external command", which is why this is NOT
//      tried first: preferring .exe avoids ever touching a shim that
//      *looks* present but doesn't run, without needing to filesystem-
//      probe the shim's target (see below).
//   3. `where claude` — falls back to a bare, extension-less install (rare
//      on Windows but matches the spike's behavior).
//
// We deliberately do NOT stat/validate the .cmd shim's target — `where`
// only proves the shim file is on PATH, not that it runs. Doing that
// validation would mean parsing/interpreting the shim's batch script (its
// target path isn't recorded anywhere else), which is fragile and still
// racy (the target could be removed between the check and the spawn).
// Trying `claude.exe` first is a simpler, deterministic policy that
// sidesteps the whole class of "shim present but broken" failures.
//
// On macOS/Linux: `which claude` (single lookup is enough — no .cmd/.exe
// vs bare-name distinction).
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
      return (await whereAsync('claude.exe')) ?? (await whereAsync('claude.cmd')) ?? (await whereAsync('claude'));
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
