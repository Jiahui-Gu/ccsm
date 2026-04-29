// Per-session JSONL tail-watcher.
//
// Owns one fs.watch + buffered read per active ccsm session. Emits
// `'state-changed'` with `{sid, state}` on TRANSITION only (it dedups
// against the last emitted state per sid so the renderer doesn't get
// spammed on every tail tick).
//
// Why fs.watch over chokidar: chokidar isn't a dep yet and #553's spec
// said to vote-and-stop before adding it silently. Plain `fs.watch` is
// good enough here because:
//   * We're watching a single file path per session, not a tree.
//   * We re-stat on every event anyway (to detect truncation/rotation).
//   * The CLI only writes frames at turn boundaries, so even Windows'
//     coalesced events fire often enough — sub-second latency for
//     idle-detection is fine.
//
// Robustness notes (per spec):
//   * File doesn't exist yet — we still install the watcher on the parent
//     directory and treat the missing file as state='running' (claude
//     just spawned and hasn't written its first frame).
//   * Mid-line read — `classifyJsonlText` tolerates JSON.parse failure on
//     the trailing line; the next fs event will carry the full content.
//   * Rotation / truncation — every read uses readFile (whole file), so
//     truncation is naturally handled. Big files: see comment in
//     `readAndClassify` — we cap reads at MAX_READ_BYTES from the tail.

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { classifyJsonlText, type WatcherState } from './inference';
import { getSessionTitle, flushPendingRename } from '../sessionTitles';

export type { WatcherState } from './inference';

export interface StateChangedEvent {
  sid: string;
  state: WatcherState;
}

export interface TitleChangedEvent {
  sid: string;
  title: string;
}

interface Entry {
  sid: string;
  jsonlPath: string;
  // Optional cwd, threaded through to `getSessionTitle({dir})` so the SDK
  // resolves the right project's JSONL. Not required (SDK falls back to a
  // global scan), but supplying it avoids an O(projects) probe per tick.
  cwd?: string;
  // Watcher on the file itself (created lazily once the file exists) and a
  // fallback watcher on the parent directory (so we notice the first
  // creation even if claude hasn't written it at startWatching time).
  fileWatcher: fs.FSWatcher | null;
  dirWatcher: fs.FSWatcher | null;
  // Install-day fallback: when the parent `projects/<projectKey>/` doesn't
  // exist yet (claude has never run for this cwd), we watch the nearest
  // existing ancestor and retry installDirWatcher when something is created
  // there. Cleaned up the moment the real dirWatcher is in place.
  ancestorWatcher: fs.FSWatcher | null;
  ancestorPath: string | null;
  lastEmitted: WatcherState | null;
  // Last title we emitted to listeners. Used to dedupe `title-changed` —
  // the watcher tick fires on every fs event, but only changes in the
  // SDK-derived `summary` warrant a renderer update.
  lastEmittedTitle: string | null;
  // Tracks whether we've ever observed the JSONL file landing on disk.
  // Used as the trigger for `flushPendingRename` (PR2's queue): the first
  // time the file appears, we know `renameSession` will succeed.
  jsonlSeen: boolean;
  // Coalesce bursts of fs events. fs.watch on Windows can fire 3-5 times
  // for a single append; we don't want to re-read + reclassify each time.
  pendingTimer: NodeJS.Timeout | null;
  closed: boolean;
}

// fs.watch on Windows can emit multiple events per write (one per
// metadata-change + data-change). 50ms is enough to coalesce without
// adding visible UX latency.
const DEBOUNCE_MS = 50;

// Cap tail reads. Real transcripts grow to 100+ MB over long sessions and
// re-reading the whole file on every event would be wasteful. We only need
// the trailing few frames to classify state. 256 KiB ≈ several dozen
// large frames, comfortably more than any single turn boundary needs.
const MAX_READ_BYTES = 256 * 1024;

class SessionWatcher extends EventEmitter {
  private entries = new Map<string, Entry>();

  startWatching(sid: string, jsonlPath: string, cwd?: string): void {
    if (!sid || !jsonlPath) return;
    const existing = this.entries.get(sid);
    if (existing) {
      // Same path: no-op. Different path: tear down + re-install. (Path
      // changes shouldn't happen in practice — the sid → jsonl mapping is
      // stable for a session's lifetime — but defend anyway.)
      if (existing.jsonlPath === jsonlPath) return;
      this.stopWatching(sid);
    }
    const entry: Entry = {
      sid,
      jsonlPath,
      cwd,
      fileWatcher: null,
      dirWatcher: null,
      ancestorWatcher: null,
      ancestorPath: null,
      lastEmitted: null,
      lastEmittedTitle: null,
      jsonlSeen: false,
      pendingTimer: null,
      closed: false,
    };
    this.entries.set(sid, entry);

    // Initial classification — file may not exist yet, in which case
    // classifyJsonlText('') returns 'running' (the empty-frames fallback).
    this.scheduleRead(entry, /*immediate*/ true);

    this.installFileWatcher(entry);
    this.installDirWatcher(entry);
  }

  stopWatching(sid: string): void {
    const entry = this.entries.get(sid);
    if (!entry) return;
    entry.closed = true;
    if (entry.pendingTimer) {
      clearTimeout(entry.pendingTimer);
      entry.pendingTimer = null;
    }
    if (entry.fileWatcher) {
      try { entry.fileWatcher.close(); } catch { /* already closed */ }
      entry.fileWatcher = null;
    }
    if (entry.dirWatcher) {
      try { entry.dirWatcher.close(); } catch { /* already closed */ }
      entry.dirWatcher = null;
    }
    if (entry.ancestorWatcher) {
      try { entry.ancestorWatcher.close(); } catch { /* already closed */ }
      entry.ancestorWatcher = null;
    }
    this.entries.delete(sid);
  }

  // For tests / shutdown.
  closeAll(): void {
    for (const sid of [...this.entries.keys()]) this.stopWatching(sid);
  }

  // Test seam.
  getLastEmittedForTest(sid: string): WatcherState | null {
    return this.entries.get(sid)?.lastEmitted ?? null;
  }

  private installFileWatcher(entry: Entry): void {
    if (entry.closed) return;
    if (!fs.existsSync(entry.jsonlPath)) return;
    try {
      entry.fileWatcher = fs.watch(entry.jsonlPath, () => {
        if (entry.closed) return;
        this.scheduleRead(entry);
      });
      entry.fileWatcher.on('error', () => {
        // File rotated / deleted under us. Drop the file watcher and let
        // the directory watcher notice the next creation.
        if (entry.fileWatcher) {
          try { entry.fileWatcher.close(); } catch { /* */ }
          entry.fileWatcher = null;
        }
      });
    } catch {
      // ENOENT or perm error — leave fileWatcher null; the dir watcher
      // will install us once the file appears.
      entry.fileWatcher = null;
    }
  }

  private installDirWatcher(entry: Entry): void {
    if (entry.closed) return;
    if (entry.dirWatcher) return;
    const dir = path.dirname(entry.jsonlPath);
    const baseName = path.basename(entry.jsonlPath);
    if (!fs.existsSync(dir)) {
      // Install-day case: parent `projects/<projectKey>/` doesn't exist yet
      // (claude has never run for this cwd). We can't fs.watch a missing
      // dir portably, so watch the nearest existing ancestor instead and
      // retry once any descendant is created. Promotes itself to a real
      // dirWatcher the moment `dir` appears.
      this.installAncestorWatcher(entry, dir);
      return;
    }
    // dir exists — drop any ancestor fallback we had.
    if (entry.ancestorWatcher) {
      try { entry.ancestorWatcher.close(); } catch { /* */ }
      entry.ancestorWatcher = null;
      entry.ancestorPath = null;
    }
    try {
      entry.dirWatcher = fs.watch(dir, (_evt, filename) => {
        if (entry.closed) return;
        // filename can be null on some platforms; in that case re-check
        // existence anyway.
        if (filename && filename !== baseName) return;
        // (Re-)install the file watcher if it wasn't yet present.
        if (!entry.fileWatcher) this.installFileWatcher(entry);
        this.scheduleRead(entry);
      });
      entry.dirWatcher.on('error', () => {
        if (entry.dirWatcher) {
          try { entry.dirWatcher.close(); } catch { /* */ }
          entry.dirWatcher = null;
        }
      });
    } catch {
      entry.dirWatcher = null;
    }
  }

  private installAncestorWatcher(entry: Entry, missingDir: string): void {
    if (entry.closed) return;
    // Walk up until we find an existing ancestor. fs.watch won't accept a
    // missing path; the nearest existing ancestor is guaranteed to exist
    // (worst case: the filesystem root).
    let ancestor = path.dirname(missingDir);
    let prev = missingDir;
    while (!fs.existsSync(ancestor) && ancestor !== prev) {
      prev = ancestor;
      ancestor = path.dirname(ancestor);
    }
    // Already watching this same ancestor — nothing to do.
    if (entry.ancestorWatcher && entry.ancestorPath === ancestor) return;
    if (entry.ancestorWatcher) {
      try { entry.ancestorWatcher.close(); } catch { /* */ }
      entry.ancestorWatcher = null;
      entry.ancestorPath = null;
    }
    try {
      entry.ancestorWatcher = fs.watch(ancestor, () => {
        if (entry.closed) return;
        // Any change in the ancestor — retry the dir-watcher chain. If the
        // immediate parent now exists, installDirWatcher will close this
        // ancestor watcher and install the real one. Otherwise it'll just
        // re-check (or re-anchor to a deeper ancestor that just appeared).
        if (entry.dirWatcher) return;
        this.installDirWatcher(entry);
        // If we successfully promoted to a real dir watcher, also try to
        // install the file watcher and re-classify in case the JSONL has
        // already landed.
        if (entry.dirWatcher) {
          if (!entry.fileWatcher) this.installFileWatcher(entry);
          this.scheduleRead(entry);
        }
      });
      entry.ancestorPath = ancestor;
      entry.ancestorWatcher.on('error', () => {
        if (entry.ancestorWatcher) {
          try { entry.ancestorWatcher.close(); } catch { /* */ }
          entry.ancestorWatcher = null;
          entry.ancestorPath = null;
        }
      });
    } catch {
      entry.ancestorWatcher = null;
      entry.ancestorPath = null;
    }
  }

  private scheduleRead(entry: Entry, immediate = false): void {
    if (entry.closed) return;
    if (entry.pendingTimer) clearTimeout(entry.pendingTimer);
    const fire = () => {
      entry.pendingTimer = null;
      if (entry.closed) return;
      this.readAndClassify(entry);
    };
    entry.pendingTimer = setTimeout(fire, immediate ? 0 : DEBOUNCE_MS);
  }

  private readAndClassify(entry: Entry): void {
    let text = '';
    let fileExists = false;
    try {
      const stat = fs.statSync(entry.jsonlPath);
      fileExists = true;
      if (stat.size === 0) {
        text = '';
      } else if (stat.size <= MAX_READ_BYTES) {
        text = fs.readFileSync(entry.jsonlPath, 'utf8');
      } else {
        // Tail-read the last MAX_READ_BYTES bytes. We may slice into the
        // middle of a frame; classifyJsonlText skips parse failures so
        // the leading partial frame is dropped naturally.
        const fd = fs.openSync(entry.jsonlPath, 'r');
        try {
          const buf = Buffer.alloc(MAX_READ_BYTES);
          fs.readSync(fd, buf, 0, MAX_READ_BYTES, stat.size - MAX_READ_BYTES);
          text = buf.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      }
    } catch {
      // File doesn't exist (yet) or is otherwise unreadable. Treat as
      // 'running' per spec.
      text = '';
    }
    const next = classifyJsonlText(text);
    if (next !== entry.lastEmitted) {
      entry.lastEmitted = next;
      this.emit('state-changed', { sid: entry.sid, state: next } as StateChangedEvent);
    }

    // First time we've ever seen the JSONL land for this sid: PR2 may have
    // queued a user-set title before the file existed (renameSession would
    // have thrown ENOENT). Flush now. Wrapped in try/catch so a queue
    // failure never crashes the watcher tick.
    if (fileExists && !entry.jsonlSeen) {
      entry.jsonlSeen = true;
      try {
        void flushPendingRename(entry.sid);
      } catch (err) {
        console.warn(
          `[sessionWatcher] flushPendingRename(${entry.sid}) threw:`,
          err instanceof Error ? err.message : err
        );
      }
    }

    // Emit title-changed if the SDK-derived summary has changed since our
    // last emission. We piggy-back on this same debounced tick (no second
    // timer). Skip the SDK call entirely until the JSONL exists — without
    // a file `getSessionInfo` would always return null.
    if (fileExists) {
      void this.maybeEmitTitle(entry);
    }
  }

  private async maybeEmitTitle(entry: Entry): Promise<void> {
    if (entry.closed) return;
    let summary: string | null = null;
    try {
      const result = await getSessionTitle(entry.sid, entry.cwd);
      summary = result.summary;
    } catch {
      // Bridge swallows ENOENT internally; anything reaching here is
      // unexpected. Skip silently — the next tick will retry.
      return;
    }
    if (entry.closed) return;
    // Only emit when we have an actual non-empty title. Both null (no
    // summary yet) and '' (empty string) are skipped — the renderer should
    // keep its existing name until the SDK has something real.
    if (typeof summary !== 'string' || summary.length === 0) return;
    if (summary === entry.lastEmittedTitle) return;
    entry.lastEmittedTitle = summary;
    this.emit('title-changed', { sid: entry.sid, title: summary } as TitleChangedEvent);
  }
}

// Module-level singleton — main.ts wires one IPC fan-out off this
// emitter and ptyHost calls start/stopWatching directly.
export const sessionWatcher = new SessionWatcher();

// Test factory — fresh instance per test, no shared state.
export function __createForTest(): SessionWatcher {
  return new SessionWatcher();
}

export type { SessionWatcher };
