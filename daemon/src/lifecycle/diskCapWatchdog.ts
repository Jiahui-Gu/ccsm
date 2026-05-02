// Task #145 — aggregate disk-cap watchdog.
//
// Spec citations:
//   - docs/superpowers/specs/v0.3-fragments/frag-6-7-reliability-security.md
//     §6.5 (telemetry caps): logs ≤ 500 MB, crash dumps ≤ 200 MB.
//   - docs/superpowers/specs/v0.3-design.md §6.6 (boot starts the watchdog;
//     shutdown stops it before step 7 log flush so the timer cannot fire
//     during pino flush).
//
// Single Responsibility (per feedback_single_responsibility):
//   - Decider (this file): on each tick, walk a directory, sum bytes, and
//     if over the cap delete the oldest files until under the cap. Pure
//     I/O — no logger, no metrics, no "delete-everything" emergency
//     branch (a runaway logger that hits 500 MB in one tick is a bug, not
//     a recovery scenario; the watchdog's job is the steady-state cap).
//   - Producer: the daemon entry-point calls `startDiskCapWatchdog` at
//     boot once both the logs and crash dirs are guaranteed to exist.
//   - Sink: per-target eviction is a single `fs.unlink` loop. Errors are
//     forwarded through `onError` so the entry-point can log without
//     coupling the watchdog to pino.
//
// What this module does NOT own:
//   - Log rotation (pino-roll T owns the per-file rotation cadence; this
//     watchdog is the umbrella size cap across all rotated files).
//   - Crash-dump fingerprinting (the supervisor's adoption path owns
//     incident-dir layout; this watchdog only enforces the size cap on
//     the resulting tree).

import * as fs from 'node:fs';
import * as path from 'node:path';

/** Default tick interval — frag-6-7 §6.5 leaves cadence to implementation;
 *  60 s is the natural floor (faster ticks waste fs syscalls; slower lets
 *  a busy day overshoot the cap meaningfully before we react). */
export const DEFAULT_DISK_CAP_TICK_MS = 60_000 as const;

/** Default caps from frag-6-7 §6.5. Numbers in BYTES so the math doesn't
 *  hide inside a unit conversion. */
export const DEFAULT_LOGS_CAP_BYTES = 500 * 1024 * 1024;
export const DEFAULT_CRASHES_CAP_BYTES = 200 * 1024 * 1024;

export interface DiskCapTarget {
  /** Absolute directory the watchdog enforces a size cap on. */
  readonly dir: string;
  /** Total cap in bytes. The watchdog evicts oldest-mtime files first
   *  until the remaining total is at or below this cap. */
  readonly capBytes: number;
  /** Optional file-name filter (e.g. only `*.log`). Default: every file
   *  recursively under `dir` counts. */
  readonly include?: (relPath: string) => boolean;
}

export interface DiskCapWatchdogOptions {
  readonly targets: readonly DiskCapTarget[];
  /** Tick cadence; default 60 s. */
  readonly tickMs?: number;
  /** Telemetry sink — invoked once per tick per target with the result. */
  readonly onTick?: (report: DiskCapTickReport) => void;
  /** Error sink — invoked when readdir/stat/unlink throws. The watchdog
   *  swallows the error and continues so a single bad file cannot stop
   *  the loop. */
  readonly onError?: (err: unknown, ctx: { dir: string; phase: 'walk' | 'unlink' }) => void;
  /** Test seam — clock + fs override. Defaults to real `setInterval`/`fs`. */
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
  readonly fsImpl?: Pick<typeof fs.promises, 'readdir' | 'stat' | 'unlink'>;
}

export interface DiskCapTickReport {
  readonly dir: string;
  readonly capBytes: number;
  readonly totalBytesBefore: number;
  readonly totalBytesAfter: number;
  readonly evictedFiles: readonly string[];
}

export interface DiskCapWatchdog {
  /** Stop the timer. Idempotent — calling stop twice is a no-op. */
  stop(): void;
  /** Run one tick immediately (for tests + for the entry-point to flush
   *  the cap once at boot before the first interval fires). */
  tickOnce(): Promise<void>;
}

interface FileEntry {
  readonly absPath: string;
  readonly relPath: string;
  readonly size: number;
  readonly mtimeMs: number;
}

async function walkDir(
  fsImpl: NonNullable<DiskCapWatchdogOptions['fsImpl']>,
  root: string,
  include: ((rel: string) => boolean) | undefined,
  onError: NonNullable<DiskCapWatchdogOptions['onError']>,
): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  async function recurse(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = (await fsImpl.readdir(dir, { withFileTypes: true })) as unknown as fs.Dirent[];
    } catch (err) {
      onError(err, { dir, phase: 'walk' });
      return;
    }
    for (const ent of entries) {
      const abs = path.join(dir, String(ent.name));
      if (ent.isDirectory()) {
        await recurse(abs);
        continue;
      }
      if (!ent.isFile()) continue;
      const rel = path.relative(root, abs);
      if (include && !include(rel)) continue;
      try {
        const st = await fsImpl.stat(abs);
        out.push({ absPath: abs, relPath: rel, size: st.size, mtimeMs: st.mtimeMs });
      } catch (err) {
        onError(err, { dir, phase: 'walk' });
      }
    }
  }
  await recurse(root);
  return out;
}

async function enforceCap(
  fsImpl: NonNullable<DiskCapWatchdogOptions['fsImpl']>,
  target: DiskCapTarget,
  onError: NonNullable<DiskCapWatchdogOptions['onError']>,
): Promise<DiskCapTickReport> {
  const files = await walkDir(fsImpl, target.dir, target.include, onError);
  const totalBefore = files.reduce((acc, f) => acc + f.size, 0);
  const evicted: string[] = [];
  if (totalBefore <= target.capBytes) {
    return Object.freeze({
      dir: target.dir,
      capBytes: target.capBytes,
      totalBytesBefore: totalBefore,
      totalBytesAfter: totalBefore,
      evictedFiles: Object.freeze(evicted),
    });
  }
  // Oldest first — frag-6-7 §6.5 doesn't pin a policy, but oldest-mtime
  // is the conventional choice for log/crash retention.
  const sorted = files.slice().sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = totalBefore;
  for (const f of sorted) {
    if (total <= target.capBytes) break;
    try {
      await fsImpl.unlink(f.absPath);
      evicted.push(f.relPath);
      total -= f.size;
    } catch (err) {
      onError(err, { dir: target.dir, phase: 'unlink' });
    }
  }
  return Object.freeze({
    dir: target.dir,
    capBytes: target.capBytes,
    totalBytesBefore: totalBefore,
    totalBytesAfter: total,
    evictedFiles: Object.freeze(evicted),
  });
}

export function startDiskCapWatchdog(opts: DiskCapWatchdogOptions): DiskCapWatchdog {
  const tickMs = opts.tickMs ?? DEFAULT_DISK_CAP_TICK_MS;
  const onTick = opts.onTick ?? (() => undefined);
  const onError = opts.onError ?? (() => undefined);
  const fsImpl = opts.fsImpl ?? fs.promises;
  const setIntervalFn = opts.setIntervalImpl ?? setInterval;
  const clearIntervalFn = opts.clearIntervalImpl ?? clearInterval;

  let stopped = false;

  async function tickOnce(): Promise<void> {
    for (const target of opts.targets) {
      if (stopped) return;
      try {
        const report = await enforceCap(fsImpl, target, onError);
        onTick(report);
      } catch (err) {
        onError(err, { dir: target.dir, phase: 'walk' });
      }
    }
  }

  const handle = setIntervalFn(() => {
    void tickOnce();
  }, tickMs);
  // Don't keep the event loop alive — shutdown's stop() is the canonical
  // exit, but if something goes wrong we don't want this timer to wedge
  // the daemon process open past process.exit.
  if (handle && typeof (handle as NodeJS.Timeout).unref === 'function') {
    (handle as NodeJS.Timeout).unref();
  }

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      clearIntervalFn(handle as NodeJS.Timeout);
    },
    tickOnce,
  };
}
