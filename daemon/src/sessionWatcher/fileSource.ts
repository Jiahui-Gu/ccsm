// Per-session JSONL fs-watch PRODUCER (daemon-side).
//
// Task #106 (v0.3 SessionWatcher 搬 daemon). Byte-identical algorithm to
// `electron/sessionWatcher/fileSource.ts` (#678 SRP refactor); only the
// hosting process changes. The daemon owns the on-disk JSONL transcripts
// going forward (pty subprocess writes them; the `~/.claude/projects/...`
// path is the same on both sides), so the watcher must also live on the
// daemon — otherwise we'd round-trip every fs.watch tick over the IPC
// bus, defeating the whole point of the daemon split.
//
// SRP: produces raw `{sid, text, fileExists, ts}` tail-read ticks. Does
// NOT classify, dedupe, emit business events, or call any other
// subsystem. Watcher upgrades (ancestor → dir → file) live here because
// they're producer correctness (we'd miss creation events otherwise).
//
// Lifecycle per sid:
//   start(sid, jsonlPath, cwd?)  → installs watchers + schedules an
//                                   immediate read; calls onTick on each
//                                   coalesced fs event.
//   stop(sid)                     → tears down all fs.watch handles +
//                                   flushes any pending debounce timer.
//   stopAll()                     → for shutdown / tests.

import * as fs from 'node:fs';
import * as path from 'node:path';

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

const DEBOUNCE_MS = 50;
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

  sids(): string[] {
    return [...this.entries.keys()];
  }

  getCwd(sid: string): string | undefined {
    return this.entries.get(sid)?.cwd;
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
      // Producer must never crash on consumer errors.
      console.warn(
        `[fileSource] tick handler threw for sid=${entry.sid}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
}
