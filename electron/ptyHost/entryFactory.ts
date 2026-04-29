// Per-session Entry construction.
//
// Extracted from electron/ptyHost/index.ts (Task #738 Phase B). The factory
// owns the wiring of one PTY: it picks --resume vs --session-id, ensures the
// import-resume JSONL is co-located with the spawn cwd's projectDir,
// constructs the headless mirror, attaches the data/exit pumps, and starts
// the JSONL tail-watcher.
//
// Side effects (sessions-map mutation, broadcast IPC) are NOT performed here;
// the caller passes:
//   - `onExit(sid)` — invoked AFTER the headless is disposed and per-attached
//     `pty:exit` broadcast has fanned out, so the caller can drop the entry
//     from its registry.
//   - `onCwdRedirect(newCwd)` — bubbled up to the renderer when the import
//     resume helper actually copied the JSONL into a new projectDir (#603).
//
// Keeping the factory I/O-typed via callbacks (rather than reaching back into
// index.ts) makes it unit-testable without an Electron runtime.
//
// SRP: single responsibility = "build one Entry"; lifecycle ops over the
// registry live in lifecycle.ts.

import * as pty from 'node-pty';
import { Terminal as HeadlessTerminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import type { WebContents } from 'electron';
import { sessionWatcher } from '../sessionWatcher';
import {
  ensureResumeJsonlAtSpawnCwd,
  findJsonlForSid,
  resolveJsonlPath,
  toClaudeSid,
} from './jsonlResolver';
import { resolveSpawnCwd } from './cwdResolver';
import { emitPtyData } from './dataFanout';

export const DEFAULT_COLS = 120;
export const DEFAULT_ROWS = 30;
export const SCROLLBACK = 5000;

export interface Entry {
  pty: pty.IPty;
  headless: HeadlessTerminal;
  serialize: SerializeAddon;
  // Multiple webContents may attach (e.g. devtools/preview windows); broadcast
  // pty:data to all of them. Keyed by webContents id so detach cleanup is O(1)
  // and we don't pin destroyed senders.
  attached: Map<number, WebContents>;
  cols: number;
  rows: number;
  /** Resolved spawn cwd (after `resolveSpawnCwd` fallback). Captured here
   *  so `listPtySessions` / `getPtySession` can return it without re-deriving. */
  cwd: string;
}

export interface MakeEntryDeps {
  /** Called after the pty exits, the headless mirror is disposed and the
   *  pty:exit IPC has fanned out. Caller drops the entry from its map here. */
  onExit: (sid: string) => void;
  /** Forwarded to `ensureResumeJsonlAtSpawnCwd` — fired only when the helper
   *  actually copied the JSONL into a new projectDir (#603). */
  onCwdRedirect?: (newCwd: string) => void;
}

export function makeEntry(
  sid: string,
  cwd: string,
  claudePath: string,
  cols: number,
  rows: number,
  deps: MakeEntryDeps,
): Entry {
  const claudeSid = toClaudeSid(sid);
  const sourceJsonl = findJsonlForSid(claudeSid);
  const flag = sourceJsonl ? '--resume' : '--session-id';
  const args = [flag, claudeSid];

  const spawnCwd = resolveSpawnCwd(cwd);

  // See `ensureResumeJsonlAtSpawnCwd` for the bug context (#603) — copies
  // the import-source JSONL into the spawn cwd's projectDir so
  // `claude --resume <sid>` can find it. No-op when source already lives
  // under the right projectKey (the common case for sessions originally
  // run from a still-existing cwd).
  //
  // When a copy actually happens, the live JSONL the CLI now appends to
  // lives under `projectKey(spawnCwd)`, NOT under `projectKey(session.cwd)`.
  // The renderer's sessionTitles bridge passes `session.cwd` to the SDK
  // (`renameSession` / `getSessionInfo` / `listForProject`), so without a
  // redirect the bridge would keep reading/writing the now-frozen SOURCE
  // file (#603 reviewer Layer-1 finding). Notify the caller so it can
  // patch `session.cwd` to `spawnCwd` in the renderer store.
  if (sourceJsonl) {
    const result = ensureResumeJsonlAtSpawnCwd(claudeSid, spawnCwd, sourceJsonl);
    if (result.copied && deps.onCwdRedirect) {
      try {
        deps.onCwdRedirect(spawnCwd);
      } catch (err) {
        console.warn(
          `[ptyHost] cwd-redirect notify for ${sid} threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  const p = pty.spawn(claudePath, args, {
    name: 'xterm-256color',
    cols,
    rows,
    cwd: spawnCwd,
    env: process.env as { [key: string]: string },
  });

  const headless = new HeadlessTerminal({
    cols,
    rows,
    scrollback: SCROLLBACK,
    allowProposedApi: true,
  });
  const serialize = new SerializeAddon();
  headless.loadAddon(serialize);

  const entry: Entry = {
    pty: p,
    headless,
    serialize,
    attached: new Map(),
    cols,
    rows,
    cwd: spawnCwd,
  };

  p.onData((chunk) => {
    headless.write(chunk);
    for (const wc of entry.attached.values()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('pty:data', { sid, chunk });
        } catch {
          /* renderer gone — best effort */
        }
      }
    }
    // Fan out to module-level data listeners (notify pipeline OSC sniffer
    // is the only production consumer today). Listeners are best-effort —
    // throws don't propagate back to ptyHost so a misbehaving sink can't
    // wedge the PTY.
    emitPtyData(sid, chunk);
  });

  p.onExit(({ exitCode, signal }) => {
    // Broadcast exit to anyone still listening, then drop the entry. Using
    // `sessionId` in the payload (not just `sid`) matches the renderer-side
    // ttyd-exit shape so the existing exit handler can be reused.
    for (const wc of entry.attached.values()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('pty:exit', {
            sessionId: sid,
            code: exitCode ?? null,
            signal: signal ?? null,
          });
        } catch {
          /* renderer gone */
        }
      }
    }
    try {
      headless.dispose();
    } catch {
      /* already disposed */
    }
    deps.onExit(sid);
    // Stop the JSONL tail-watcher so we don't keep an fs.watch handle
    // pinned for a dead session.
    try { sessionWatcher.stopWatching(sid); } catch { /* never throws */ }
  });

  // Start a JSONL tail-watcher for this session. The watcher emits
  // 'state-changed' on the singleton in electron/sessionWatcher; main.ts
  // bridges those events to the renderer (`session:state` IPC channel).
  try {
    const jsonlPath = resolveJsonlPath(claudeSid, spawnCwd);
    if (jsonlPath) sessionWatcher.startWatching(sid, jsonlPath, spawnCwd);
  } catch {
    /* watcher start is best-effort; PTY still owns its lifecycle */
  }

  return entry;
}
