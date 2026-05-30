// Log-file rotation archivers for the main-process logger. These are the
// `electron-log` `archiveLogFn` hooks — they run synchronously when the live
// file hits `maxSize`.

import * as fs from 'node:fs';
import * as path from 'node:path';

/** 10-file rotation for the primary main log. electron-log v5 only keeps ONE
 *  rotated archive by default (renames `main.log` → `main.old.log`); we
 *  override to cycle through `main.1.log` … `main.10.log`. */
export function archiveMainLog(oldLog: unknown): void {
  const file = String(oldLog);
  const dir = path.dirname(file);
  const base = path.basename(file, '.log');
  // Shift main.9.log → main.10.log, main.8.log → main.9.log, …
  try {
    for (let i = 9; i >= 1; i--) {
      const from = path.join(dir, `${base}.${i}.log`);
      const to = path.join(dir, `${base}.${i + 1}.log`);
      if (fs.existsSync(from)) {
        if (i + 1 > 10) {
          fs.unlinkSync(from);
        } else {
          fs.renameSync(from, to);
        }
      }
    }
    const renamed = path.join(dir, `${base}.1.log`);
    fs.renameSync(file, renamed);
  } catch (e) {
    // Best-effort: if rotation fails (locked file on Windows etc.) we
    // emit a console.error but keep logging — the live file is the
    // bigger concern than the archive chain.
    console.error('[log] rotation failed:', e);
  }
}

/** 2-file ring for the renderer-mirror log (1MB × 2 = 2MB cap per design v2). */
export function archiveRendererLog(oldLog: unknown): void {
  const file = String(oldLog);
  const dir = path.dirname(file);
  const base = path.basename(file, '.log');
  try {
    const archive = path.join(dir, `${base}.1.log`);
    if (fs.existsSync(archive)) fs.unlinkSync(archive);
    fs.renameSync(file, archive);
  } catch {
    /* best-effort */
  }
}
