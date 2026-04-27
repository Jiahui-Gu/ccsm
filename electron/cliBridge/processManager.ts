// Per-session ttyd lifecycle.
//
// One ttyd process per ccsm session. Each ttyd wraps a fresh `claude`
// invocation and exposes it on a dedicated port for the renderer's
// `<iframe src="http://127.0.0.1:<port>">`.
//
// Lifecycle:
//   - openTtydForSession  → spawn ttyd with `claude --session-id <uuid>`
//                           (new chat). Returns {port, sid}. Caller keys
//                           ccsm's session row by `sid` so the JSONL
//                           transcript on disk and ccsm's session id
//                           agree (matches the existing agent:start
//                           pre-allocated-uuid pattern).
//   - resumeTtydForSession → spawn ttyd with `claude --resume <sid>`
//                            (re-attach to an existing CLI session).
//   - killTtydForSession  → tree-kill the ttyd PID (Windows: taskkill
//                            /F /T). Does NOT delete the JSONL — the CLI
//                            owns that data; ccsm only manages process
//                            lifecycle.
//
// Exit handling: ttyd exiting unexpectedly (claude crashed, OOM, user
// closed terminal via Ctrl+D) emits a `cliBridge:ttyd-exit` IPC event
// to the renderer with `{sessionId, code, signal}`. The renderer can
// re-open via openTtydForSession (new chat) or resumeTtydForSession
// (continue with the same sid).
//
// Q10 verified: `claude --session-id <uuid>` IS supported by the
// installed CLI (`claude --help` confirms `--session-id <uuid>  Use a
// specific session ID for the conversation (must be a valid UUID)`).
// We use Q10A (ccsm pre-allocates UUID) — no JSONL directory polling
// fallback needed.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import type { WebContents } from 'electron';
import { pickFreePort } from './portAllocator';
import { resolveClaude } from './claudeResolver';
import { ttydBinaryPath } from './ttydBinary';

export interface TtydEntry {
  proc: ChildProcess;
  port: number;
  sid: string;
  status: 'starting' | 'running' | 'exited';
}

export interface OpenResult {
  ok: true;
  port: number;
  sid: string;
}

export interface OpenError {
  ok: false;
  error: string;
}

const sessions = new Map<string, TtydEntry>();
let sender: WebContents | null = null;

export function bindSender(wc: WebContents): void {
  sender = wc;
}

function emitExit(sessionId: string, code: number | null, signal: NodeJS.Signals | null): void {
  if (sender && !sender.isDestroyed()) {
    try {
      sender.send('cliBridge:ttyd-exit', { sessionId, code, signal });
    } catch {
      /* renderer gone — best effort */
    }
  }
}

// Shared spawn helper. `claudeArgs` is the list AFTER the ttyd-owned
// flags (`-p <port> -W -t fontSize=14 <claudePath>`); for new sessions
// it's `['--session-id', sid]`, for resumes `['--resume', sid]`.
async function spawnTtyd(
  sessionId: string,
  claudeArgs: string[],
): Promise<OpenResult | OpenError> {
  // Refuse to start a second ttyd for the same ccsm session — the prior
  // one would leak. Caller should explicitly kill first if they want a
  // restart. Surfacing the error rather than silently rotating keeps the
  // renderer state machine simple.
  const existing = sessions.get(sessionId);
  if (existing && existing.status !== 'exited') {
    return { ok: false, error: 'session_already_running' };
  }

  const ttyd = ttydBinaryPath();
  if (!ttyd) {
    return { ok: false, error: 'ttyd_binary_missing' };
  }
  const claudePath = resolveClaude();
  if (!claudePath) {
    return { ok: false, error: 'claude_not_found' };
  }

  let port: number;
  try {
    port = await pickFreePort();
  } catch (err) {
    return {
      ok: false,
      error: `port_allocation_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // ttyd flags:
  //   -p <port>           bind 127.0.0.1 by default; we don't pass -i so
  //                       it stays loopback-only (no LAN exposure).
  //   -W                  writable (allow keystrokes from the browser).
  //                       Without it the user could only watch.
  //   -t fontSize=14      pass-through to the embedded xterm.js client
  //                       (matches ccsm's renderer typography density).
  //
  // Trailing positional args: the program ttyd should exec inside the
  // pty — the absolute claude path + the per-mode args (--session-id
  // for new, --resume for continue).
  const args = [
    '-p',
    String(port),
    '-W',
    '-t',
    'fontSize=14',
    claudePath,
    ...claudeArgs,
  ];

  let proc: ChildProcess;
  try {
    proc = spawn(ttyd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
  } catch (err) {
    return {
      ok: false,
      error: `spawn_failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Determine sid: if --session-id was passed, the caller already chose
  // it; if --resume was passed, the second arg is the existing sid.
  // Either way, claudeArgs[1] is the sid we want to surface back.
  const sid = claudeArgs[1] ?? '';

  const entry: TtydEntry = { proc, port, sid, status: 'starting' };
  sessions.set(sessionId, entry);

  // Drain stdout/stderr so the pipe buffers don't fill and stall ttyd.
  // We log at info level — useful for first-line user reports of "the
  // terminal won't open"; rare enough not to spam in steady-state.
  proc.stdout?.on('data', (b: Buffer) => {
    console.log(`[cliBridge ttyd ${sessionId}] ${b.toString().trimEnd()}`);
  });
  proc.stderr?.on('data', (b: Buffer) => {
    console.warn(`[cliBridge ttyd ${sessionId}] ${b.toString().trimEnd()}`);
  });

  proc.on('exit', (code, signal) => {
    const cur = sessions.get(sessionId);
    if (cur && cur.proc === proc) {
      cur.status = 'exited';
    }
    emitExit(sessionId, code, signal);
  });

  // Tiny delay so ttyd's HTTP listener is up before the renderer
  // creates the iframe. The spike used 400ms; 200ms has been adequate
  // in local testing and keeps new-session latency lower. If we ever
  // see iframe-loads-before-server-ready failures in the wild we can
  // bump this back up or move to a "tail stderr until 'Listening on'"
  // probe.
  await new Promise((r) => setTimeout(r, 200));

  // If ttyd died during the warm-up window, surface the failure rather
  // than returning a port that won't accept a connection.
  const post = sessions.get(sessionId);
  if (!post || post.status === 'exited') {
    return { ok: false, error: 'ttyd_exited_during_warmup' };
  }
  post.status = 'running';

  return { ok: true, port, sid };
}

export async function openTtydForSession(
  sessionId: string,
): Promise<OpenResult | OpenError> {
  const sid = randomUUID();
  return spawnTtyd(sessionId, ['--session-id', sid]);
}

export async function resumeTtydForSession(
  sessionId: string,
  sid: string,
): Promise<OpenResult | OpenError> {
  if (typeof sid !== 'string' || !sid) {
    return { ok: false, error: 'bad_sid' };
  }
  return spawnTtyd(sessionId, ['--resume', sid]);
}

// Kill the ttyd process tree for `sessionId`. On Windows we MUST use
// `taskkill /T /F /PID` to walk the child tree (ttyd → conpty → claude →
// node), otherwise the claude process leaks and continues holding the
// JSONL file open. POSIX path uses SIGKILL (we'll add `process.kill(-pgid)`
// when we add macOS/Linux ttyd binaries; for now Windows is the only
// codepath that runs in production).
//
// Idempotent: safe to call on an already-exited or never-spawned
// session — returns `{ok: true, killed: false}` so callers don't have
// to special-case.
export function killTtydForSession(sessionId: string): { ok: true; killed: boolean } {
  const entry = sessions.get(sessionId);
  if (!entry || entry.status === 'exited' || !entry.proc.pid) {
    sessions.delete(sessionId);
    return { ok: true, killed: false };
  }
  const pid = entry.proc.pid;
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(pid)], {
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      try {
        entry.proc.kill();
      } catch {
        /* nothing left to do */
      }
    }
  } else {
    try {
      entry.proc.kill('SIGKILL');
    } catch {
      /* ignore */
    }
  }
  entry.status = 'exited';
  sessions.delete(sessionId);
  return { ok: true, killed: true };
}

export function killAll(): void {
  for (const sessionId of [...sessions.keys()]) {
    killTtydForSession(sessionId);
  }
}

// Test seam — used by harness-real-cli's ttyd cases to inspect the
// running map. Production code never reads from this.
export function __getEntryForTest(sessionId: string): TtydEntry | undefined {
  return sessions.get(sessionId);
}
