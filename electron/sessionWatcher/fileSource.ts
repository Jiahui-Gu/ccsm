// Per-session JSONL fs-watch PRODUCER.
//
// SRP: produces raw `{sid, text, fileExists, ts}` tail-read ticks. Does
// NOT classify, dedupe, emit business events, or call any other
// subsystem. Watcher upgrades (ancestor → dir → file) live here because
// they're producer correctness (we'd miss creation events otherwise),
// not policy.
//
// Lifecycle per sid:
//   start(sid, jsonlPath, cwd?)  → installs watchers + schedules an
//                                   immediate read; calls onTick on each
//                                   coalesced fs event.
//   stop(sid)                     → tears down all fs.watch handles +
//                                   flushes any pending debounce timer.
//   stopAll()                     → for shutdown / tests.
//
// Robustness notes (carried over from the pre-split index.ts):
//   * File doesn't exist yet → install dirWatcher; if dir is also missing
//     (install-day, claude has never run for this cwd), walk up to the
//     nearest existing ancestor and watch that, retrying installDirWatcher
//     when anything in the ancestor changes.
//   * Mid-write reads → we just hand the raw text to the consumer; the
//     decider (classifyJsonlText) tolerates JSON.parse failures.
//   * Rotation / truncation → readFile reads whole file; truncation is
//     naturally handled. Files > MAX_READ_BYTES are tail-read.
//   * Windows fs.watch fires multiple events per write → DEBOUNCE_MS
//     coalesces.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Raw producer tick — exactly what's on disk right now, no
 *  classification or dedupe. */
export interface FileTick {
  sid: string;
  text: string;
  fileExists: boolean;
  ts: number;
}

export type TickHandler = (tick: FileTick) => void;

interface Entry {
  sid: string;
  jsonlPath: string;
  cwd?: string;
  fileWatcher: fs.FSWatcher | null;
  dirWatcher: fs.FSWatcher | null;
  ancestorWatcher: fs.FSWatcher | null;
  ancestorPath: string | null;
  pendingTimer: NodeJS.Timeout | null;
  closed: boolean;
}

// fs.watch on Windows can emit multiple events per write (one per
// metadata-change + data-change). 50ms is enough to coalesce without
// adding visible UX latency.
const DEBOUNCE_MS = 50;

// Cap tail reads. Real transcripts grow to 100+ MB over long sessions
// and re-reading the whole file on every event would be wasteful.
const MAX_READ_BYTES = 256 * 1024;

export class FileSource {
  private entries = new Map<string, Entry>();
  private onTick: TickHandler;

  constructor(onTick: TickHandler) {
    this.onTick = onTick;
  }

  start(sid: string, jsonlPath: string, cwd?: string): void {
    if (!sid || !jsonlPath) return;
    const existing = this.entries.get(sid);
    if (existing) {
      if (existing.jsonlPath === jsonlPath) return;
      this.stop(sid);
    }
    const entry: Entry = {
      sid,
      jsonlPath,
      cwd,
      fileWatcher: null,
      dirWatcher: null,
      ancestorWatcher: null,
      ancestorPath: null,
      pendingTimer: null,
      closed: false,
    };
    this.entries.set(sid, entry);

    // Initial classification — file may not exist yet.
    this.scheduleRead(entry, /*immediate*/ true);

    this.installFileWatcher(entry);
    this.installDirWatcher(entry);
  }

  stop(sid: string): boolean {
    const entry = this.entries.get(sid);
    if (!entry) return false;
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
    return true;
  }

  stopAll(): void {
    for (const sid of [...this.entries.keys()]) this.stop(sid);
  }

  hasSid(sid: string): boolean {
    return this.entries.has(sid);
  }

  /** Snapshot of currently-tracked sids. Used by the facade for
   *  closeAll() so we don't have to expose the entries map. */
  sids(): string[] {
    return [...this.entries.keys()];
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
        if (entry.fileWatcher) {
          try { entry.fileWatcher.close(); } catch { /* */ }
          entry.fileWatcher = null;
        }
      });
    } catch {
      entry.fileWatcher = null;
    }
  }

  private installDirWatcher(entry: Entry): void {
    if (entry.closed) return;
    if (entry.dirWatcher) return;
    const dir = path.dirname(entry.jsonlPath);
    const baseName = path.basename(entry.jsonlPath);
    if (!fs.existsSync(dir)) {
      this.installAncestorWatcher(entry, dir);
      return;
    }
    if (entry.ancestorWatcher) {
      try { entry.ancestorWatcher.close(); } catch { /* */ }
      entry.ancestorWatcher = null;
      entry.ancestorPath = null;
    }
    try {
      entry.dirWatcher = fs.watch(dir, (_evt, filename) => {
        if (entry.closed) return;
        if (filename && filename !== baseName) return;
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
    let ancestor = path.dirname(missingDir);
    let prev = missingDir;
    while (!fs.existsSync(ancestor) && ancestor !== prev) {
      prev = ancestor;
      ancestor = path.dirname(ancestor);
    }
    if (entry.ancestorWatcher && entry.ancestorPath === ancestor) return;
    if (entry.ancestorWatcher) {
      try { entry.ancestorWatcher.close(); } catch { /* */ }
      entry.ancestorWatcher = null;
      entry.ancestorPath = null;
    }
    try {
      entry.ancestorWatcher = fs.watch(ancestor, () => {
        if (entry.closed) return;
        if (entry.dirWatcher) return;
        this.installDirWatcher(entry);
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
    const fire = (): void => {
      entry.pendingTimer = null;
      if (entry.closed) return;
      this.readAndEmit(entry);
    };
    entry.pendingTimer = setTimeout(fire, immediate ? 0 : DEBOUNCE_MS);
  }

  private readAndEmit(entry: Entry): void {
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
      text = '';
    }
    try {
      this.onTick({ sid: entry.sid, text, fileExists, ts: Date.now() });
    } catch (err) {
      // Producer must never crash on consumer errors. Log + carry on.
      console.warn(
        `[fileSource] tick handler threw for sid=${entry.sid}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Test seam: get the resolved cwd for a sid, used by sinks that need
   *  to thread cwd through to other subsystems. */
  getCwd(sid: string): string | undefined {
    return this.entries.get(sid)?.cwd;
  }
}
