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
// install claude or change PATH while ccsm runs; we don't bust the
// cache automatically — that's a "restart ccsm" event in practice. A
// future task can add a `cliBridge:rescanClaude` IPC if the need arises.

import { spawnSync } from 'node:child_process';

let cached: string | null | undefined; // undefined = never tried

function tryWhere(name: string): string | null {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const r = spawnSync(cmd, [name], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0) return null;
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    return first ? first.trim() : null;
  } catch {
    return null;
  }
}

export function resolveClaude(): string | null {
  if (cached !== undefined) return cached;
  if (process.platform === 'win32') {
    cached = tryWhere('claude.cmd') ?? tryWhere('claude');
  } else {
    cached = tryWhere('claude');
  }
  return cached;
}

// Test seam — used by harness-real-cli's ttyd cases to force a fresh
// lookup between cases. Production code never invokes this.
export function __resetClaudeResolverForTest(): void {
  cached = undefined;
}
