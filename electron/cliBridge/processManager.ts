// Per-session ttyd lifecycle.
//
// One ttyd process per ccsm session. Each ttyd wraps a fresh `claude`
// invocation and exposes it on a dedicated port for the renderer's
// `<iframe src="http://127.0.0.1:<port>">`.
//
// Lifecycle:
//   - openTtydForSession  → spawn ttyd with `claude --session-id <uuid>`
//                           when no on-disk JSONL exists for the projected
//                           sid (fresh session), OR `claude --resume <uuid>`
//                           when one does (app restart, imported transcript,
//                           prior in-app spawn that exited). The on-disk
//                           JSONL is the only ground truth — fixes #507/#508
//                           where always passing `--session-id` made claude
//                           reject with "Session ID is already in use." on
//                           any rehydrated session. Returns {port, sid}.
//                           Caller keys ccsm's session row by `sid` so the
//                           JSONL transcript on disk and ccsm's session id
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
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join as pathJoin } from 'node:path';
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

// claude --session-id requires a valid UUID. ccsm session ids are raw UUID v4
// for sessions created after the store.ts switch to crypto.randomUUID(); but
// legacy persisted rows carry the older `s-<uuid>` shape, and other prefixes
// may exist too. To keep ccsm session.id ↔ claude session-id ↔ JSONL filename
// in lockstep WITHOUT a side-table, we accept any string and deterministically
// project it onto a UUID v4 string: SHA-256 the input, splice into the v4
// layout (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx). The same ccsm sid always
// maps to the same claude sid, so reopening a session targets the same JSONL
// file — and a raw UUID input round-trips to itself when checked against the
// regex first (no double-mapping for new sessions).
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function toClaudeSid(ccsmSessionId: string): string {
  if (UUID_V4_RE.test(ccsmSessionId)) return ccsmSessionId.toLowerCase();
  const hex = createHash('sha256').update(ccsmSessionId).digest('hex');
  const yNibble = (parseInt(hex[16], 16) & 0x3) | 0x8; // RFC 4122 variant
  return (
    `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-` +
    `${yNibble.toString(16)}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
  );
}

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
//
// `cwd` is the directory `claude` should be launched in. Without it,
// claude inherits Electron's cwd and writes its JSONL transcripts to
// `~/.claude/projects/<electron-cwd>/...` instead of the user's chosen
// project — also picking up settings/agents/skills from the wrong
// project context (P0 dogfood blocker).
async function spawnTtyd(
  sessionId: string,
  cwd: string,
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
  //   -p <port>           listen port.
  //   -i 127.0.0.1        bind interface. ttyd's default is 0.0.0.0 (all
  //                       interfaces), which on Windows triggers a
  //                       Defender Firewall "Allow on private/public
  //                       networks?" prompt every spawn. We explicitly
  //                       restrict to loopback so no LAN exposure and no
  //                       firewall prompt.
  //   -W                  writable (allow keystrokes from the browser).
  //                       Without it the user could only watch.
  //   -t fontSize=14      pass-through to the embedded xterm.js client
  //                       (matches ccsm's renderer typography density).
  //   -t theme=...        match xterm bg to ccsm host bg (#0B0B0C) so
  //                       the embedded TUI doesn't visually appear as a
  //                       broken/unrendered slab. xterm's default
  //                       rgb(43,43,43) reads as off-by-a-shade against
  //                       the ccsm window and previously caused multiple
  //                       wasted-effort rounds (#499).
  //
  // Trailing positional args: the program ttyd should exec inside the
  // pty — the absolute claude path + the per-mode args (--session-id
  // for new, --resume for continue).
  const args = [
    '-p',
    String(port),
    '-i',
    '127.0.0.1',
    '-W',
    '-t',
    'fontSize=14',
    '-t',
    'theme={"background":"#0B0B0C"}',
    claudePath,
    ...claudeArgs,
  ];

  let proc: ChildProcess;
  try {
    proc = spawn(ttyd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      // Run claude inside the user's chosen project dir so JSONLs land
      // under `~/.claude/projects/<this-dir>/<sid>.jsonl` and the CLI
      // picks up settings/agents/skills from the right project root.
      // Falsy cwd → fall back to Electron's cwd (early-boot only).
      cwd: cwd && cwd.length > 0 ? cwd : undefined,
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
  cwd: string,
): Promise<OpenResult | OpenError> {
  // Reuse existing ttyd if one is already running for this session — keeps
  // the conversation alive across renderer-side TtydPane unmount/remount
  // (e.g. user switches sessionA → sessionB → sessionA). Without this,
  // returning `session_already_running` here would force the renderer to
  // either kill+respawn (losing context) or special-case the error.
  const existing = sessions.get(sessionId);
  if (existing && existing.status === 'running') {
    return { ok: true, port: existing.port, sid: existing.sid };
  }
  // Use the ccsm session id as the claude --session-id (UUID-projected so
  // legacy `s-<uuid>` rows still satisfy claude's UUID requirement). Same
  // ccsm sid → same JSONL file under ~/.claude/projects/<cwd>/<sid>.jsonl
  // → ccsm sidebar ↔ on-disk transcript stay aligned (the previous
  // randomUUID() per spawn caused divergence + orphaned JSONLs).
  const sid = toClaudeSid(sessionId);
  // If the JSONL transcript already exists on disk for this sid (app
  // restart, imported session, prior in-app spawn that exited), claude
  // refuses `--session-id <sid>` with "Session ID is already in use." We
  // must `--resume <sid>` instead so the prior conversation reattaches.
  // Fixes #507 (UX G reopen-resume) and #508 (UX H import-resume).
  //
  // Backend-decides over renderer-decides: the on-disk JSONL is the only
  // source of truth — the renderer cannot distinguish a fresh-this-session
  // sid from a rehydrated-from-persistence sid without a roundtrip anyway.
  // Keeping the decision here means a single codepath for both new and
  // rehydrated sessions, and no new IPC surface.
  if (jsonlExistsForSid(sid)) {
    return spawnTtyd(sessionId, cwd, ['--resume', sid]);
  }
  return spawnTtyd(sessionId, cwd, ['--session-id', sid]);
}

// Synchronously locate a `<sid>.jsonl` transcript anywhere under the
// claude projects root(s). claude encodes each cwd as a flattened
// directory name (e.g. `C:\foo\bar` → `C--foo-bar`); rather than
// reproducing that encoding (which we don't fully own — it's a CLI
// implementation detail), scan all project subdirs and return true on
// first match. ~tens of dirs in steady state, single readdir + a per-dir
// existsSync — well below the spawnTtyd 200ms warmup budget.
//
// Two roots to scan, mirroring two codepaths:
//   1. `${CLAUDE_CONFIG_DIR}/projects/` when env is set — matches where
//      ccsm-spawned claude writes transcripts (commands-loader.ts uses
//      CLAUDE_CONFIG_DIR as a full replacement for ~/.claude).
//   2. `${HOME}/.claude/projects/` — matches where the import scanner
//      reads imported transcripts from (import-scanner.ts uses
//      `os.homedir() + .claude` directly), and where production claude
//      writes when CLAUDE_CONFIG_DIR is unset.
// Production: both resolve to the same path so we deduplicate. The
// probes set HOME and CLAUDE_CONFIG_DIR to the same tempDir but the
// scanner places imports under `${tempDir}/.claude/projects/` while
// spawned claude writes to `${tempDir}/projects/` — so we need both.
//
// Best-effort: any fs error → treat as "no transcript", which falls
// back to `--session-id` (the prior behavior).
function jsonlExistsForSid(sid: string): boolean {
  const roots = new Set<string>();
  if (process.env.CLAUDE_CONFIG_DIR) {
    roots.add(pathJoin(process.env.CLAUDE_CONFIG_DIR, 'projects'));
  }
  roots.add(pathJoin(homedir(), '.claude', 'projects'));
  const filename = `${sid}.jsonl`;
  for (const root of roots) {
    let dirs: string[];
    try {
      dirs = readdirSync(root);
    } catch {
      continue;
    }
    for (const d of dirs) {
      const candidate = pathJoin(root, d, filename);
      try {
        if (existsSync(candidate)) {
          // Guard against accidentally matching a 0-byte placeholder; only
          // treat the file as a real transcript when there's content to
          // resume. A truly fresh `--session-id` spawn has no JSONL yet,
          // so a stat here can't false-positive on what we just spawned.
          const st = statSync(candidate);
          if (st.isFile() && st.size > 0) return true;
        }
      } catch {
        /* skip unreadable entries */
      }
    }
  }
  return false;
}

export async function resumeTtydForSession(
  sessionId: string,
  cwd: string,
  sid: string,
): Promise<OpenResult | OpenError> {
  if (typeof sid !== 'string' || !sid) {
    return { ok: false, error: 'bad_sid' };
  }
  return spawnTtyd(sessionId, cwd, ['--resume', sid]);
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

// Look up the running ttyd for `sessionId` so the renderer can reuse it
// instead of always spawning a new one on TtydPane mount. Returns the
// {port, sid} pair when the entry exists and is still running; null
// otherwise (never started, or already exited). The renderer uses this
// to render <iframe> against the existing port when switching back to a
// session it had open earlier.
export function getTtydForSession(sessionId: string): { port: number; sid: string } | null {
  const entry = sessions.get(sessionId);
  if (!entry || entry.status !== 'running') return null;
  return { port: entry.port, sid: entry.sid };
}

// Test seam — used by harness-real-cli's ttyd cases to inspect the
// running map. Production code never reads from this.
export function __getEntryForTest(sessionId: string): TtydEntry | undefined {
  return sessions.get(sessionId);
}
