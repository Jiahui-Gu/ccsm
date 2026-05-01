// electron/crash/collector.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';
import { createIncidentDir, writeMeta, writeReadme, IncidentMeta } from './incident-dir';
import { scrubHomePath } from './scrub';

export interface SerializedError { message: string; stack?: string; name?: string }

export interface IncidentInput {
  surface: IncidentMeta['surface'];
  error?: SerializedError;
  exitCode?: number | null;
  signal?: string | null;
  stderrTail?: string[];
  stdoutTail?: string[];
  lastTraceId?: string;
  bootNonce?: string;
  lastHealthzAgoMs?: number | null;
  markerPath?: string; // path to <runtimeRoot>/crash/<bootNonce>.json
}

export interface CollectorOpts {
  crashRoot: string;
  dmpStaging: string;
  appVersion: string;
  electronVersion: string;
}

export interface CrashCollector {
  recordIncident(input: IncidentInput): string;
  flush(): Promise<void>;
  pruneRetention(opts: { maxCount: number; maxAgeDays: number }): void;
}

export function startCrashCollector(opts: CollectorOpts): CrashCollector {
  fs.mkdirSync(opts.crashRoot, { recursive: true });
  fs.mkdirSync(opts.dmpStaging, { recursive: true });

  function adoptDmps(dir: string): void {
    if (!fs.existsSync(opts.dmpStaging)) return;
    const entries = fs.readdirSync(opts.dmpStaging)
      .filter(n => n.endsWith('.dmp'))
      .map(n => ({ n, m: fs.statSync(path.join(opts.dmpStaging, n)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    let first = true;
    for (const { n } of entries) {
      const src = path.join(opts.dmpStaging, n);
      const dst = path.join(dir, first ? 'frontend.dmp' : `frontend-${n}`);
      try {
        fs.renameSync(src, dst);
        first = false;
      } catch {
        // rename race; another collector consumed it. swallow.
      }
    }
  }

  function adoptMarker(dir: string, markerPath?: string): boolean {
    if (!markerPath || !fs.existsSync(markerPath)) return false;
    try {
      fs.renameSync(markerPath, path.join(dir, 'daemon-marker.json'));
      return true;
    } catch {
      return false;
    }
  }

  function recordIncident(input: IncidentInput): string {
    const id = ulid();
    const dir = createIncidentDir(opts.crashRoot, id);
    const ts = new Date().toISOString();

    if (input.stderrTail) {
      fs.writeFileSync(path.join(dir, 'stderr-tail.txt'),
        input.stderrTail.map(scrubHomePath).join('\n') + '\n', 'utf8');
    }
    if (input.stdoutTail) {
      fs.writeFileSync(path.join(dir, 'stdout-tail.txt'),
        input.stdoutTail.map(scrubHomePath).join('\n') + '\n', 'utf8');
    }
    if (input.error) {
      fs.writeFileSync(path.join(dir, 'error.json'),
        JSON.stringify({
          name: input.error.name,
          message: scrubHomePath(input.error.message ?? ''),
          stack: input.error.stack ? scrubHomePath(input.error.stack) : undefined,
        }, null, 2), 'utf8');
    }

    const markerPresent = adoptMarker(dir, input.markerPath);
    adoptDmps(dir);

    const meta: IncidentMeta = {
      schemaVersion: 1,
      incidentId: id,
      ts,
      surface: input.surface,
      appVersion: opts.appVersion,
      electronVersion: opts.electronVersion,
      os: { platform: process.platform, release: os.release(), arch: process.arch },
      backend: input.surface.startsWith('daemon') ? {
        exitCode: input.exitCode ?? null,
        signal: input.signal ?? null,
        bootNonce: input.bootNonce,
        lastTraceId: input.lastTraceId,
        lastHealthzAgoMs: input.lastHealthzAgoMs ?? null,
        markerPresent,
      } : undefined,
    };
    writeMeta(dir, meta);
    writeReadme(dir, summarize(meta, input));
    return dir;
  }

  function summarize(meta: IncidentMeta, input: IncidentInput): string {
    const lines = [
      `CCSM crash report ${meta.incidentId}`,
      `time:    ${meta.ts}`,
      `surface: ${meta.surface}`,
      `app:     ${meta.appVersion}  electron: ${meta.electronVersion}`,
      `os:      ${meta.os.platform} ${meta.os.release} ${meta.os.arch}`,
    ];
    if (meta.backend) {
      lines.push(`exit:    code=${meta.backend.exitCode} signal=${meta.backend.signal}`);
      lines.push(`bootNonce: ${meta.backend.bootNonce ?? '(none)'}  lastTraceId: ${meta.backend.lastTraceId ?? '(none)'}`);
    }
    if (input.error) lines.push('', 'error:', `  ${input.error.message}`);
    return lines.join('\n') + '\n';
  }

  function pruneRetention({ maxCount, maxAgeDays }: { maxCount: number; maxAgeDays: number }): void {
    const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
    let entries: { name: string; mtime: number }[];
    try {
      entries = fs.readdirSync(opts.crashRoot)
        .filter(n => !n.startsWith('_'))
        .map(n => ({ name: n, mtime: fs.statSync(path.join(opts.crashRoot, n)).mtimeMs }))
        .sort((a, b) => b.mtime - a.mtime); // newest first
    } catch {
      return;
    }
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i]!;
      const tooOld = e.mtime < cutoff;
      const overCount = i >= maxCount;
      // Keep larger of "20 newest" and "all within 30 days".
      if (tooOld || overCount) {
        try { fs.rmSync(path.join(opts.crashRoot, e.name), { recursive: true, force: true }); } catch {}
      }
    }
  }

  async function flush(): Promise<void> { /* sentry flush hooked in phase 2 */ }

  return { recordIncident, flush, pruneRetention };
}
