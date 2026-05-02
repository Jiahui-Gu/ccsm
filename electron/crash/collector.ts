// electron/crash/collector.ts
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from 'ulid';
import { createIncidentDir, writeMeta, writeReadme, IncidentMeta } from './incident-dir';
import { scrubHomePath, redactSecrets } from './scrub';

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

export interface PruneOpts {
  /** Legacy global cap — prune entries that are BOTH older than `maxAgeDays`
   *  AND beyond the `maxCount` newest. Phase 1 contract. Optional now. */
  maxCount?: number;
  /** Legacy global age threshold (days). Pairs with `maxCount`. */
  maxAgeDays?: number;
  /** Phase 5 — keep the N newest incidents per surface (by mtime). When
   *  omitted, only the legacy global cap applies. Default at the call site
   *  is 20 (`crashLogRetention.maxPerSurface`). */
  maxPerSurface?: number;
  /** Phase 5 — never prune an incident that has NO `.uploaded` marker AND
   *  whose mtime is younger than this many days, so the user can still send
   *  it via the Help-menu re-upload button (phase 4). Default 7. */
  protectUnsentYoungerThanDays?: number;
  /** Task #59 / spec frag-6-7 §6.6.3 + §6.6.1 — aggregate per-side byte cap
   *  for `<dataRoot>/crashes/`. Pruned oldest-first (by mtime) when total
   *  on-disk size of incident dirs exceeds this cap. Protect-unsent has
   *  priority: a protected dir is never deleted to satisfy the cap; if the
   *  cap cannot be hit without deleting protected dirs we log warn + skip.
   *  Default at the call site is 200 MB. */
  maxAggregateBytes?: number;
}

export interface CrashCollector {
  recordIncident(input: IncidentInput): string;
  flush(): Promise<void>;
  pruneRetention(opts: PruneOpts): void;
}

/** Recursively sum file sizes inside an incident dir. Best-effort: files
 *  removed mid-walk (race with another collector) are skipped. */
function computeDirBytes(dir: string): number {
  let total = 0;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch { return 0; }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    try {
      if (ent.isDirectory()) {
        total += computeDirBytes(full);
      } else if (ent.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // file vanished or permission flake; skip.
    }
  }
  return total;
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

    // Apply both home-path scrub AND secret redact (frag-6-7 §6.6.3) before
    // any crash artifact lands on disk. redactSecrets covers Authorization /
    // Cookie headers, ANTHROPIC_API_KEY=... env-style assignments, and
    // structured *.secret / *.apiKey property names that may appear in
    // stack traces or stderr tails.
    if (input.stderrTail) {
      fs.writeFileSync(path.join(dir, 'stderr-tail.txt'),
        input.stderrTail.map(line => redactSecrets(scrubHomePath(line))).join('\n') + '\n', 'utf8');
    }
    if (input.stdoutTail) {
      fs.writeFileSync(path.join(dir, 'stdout-tail.txt'),
        input.stdoutTail.map(line => redactSecrets(scrubHomePath(line))).join('\n') + '\n', 'utf8');
    }
    if (input.error) {
      fs.writeFileSync(path.join(dir, 'error.json'),
        JSON.stringify({
          name: input.error.name,
          message: redactSecrets(scrubHomePath(input.error.message ?? '')),
          stack: input.error.stack ? redactSecrets(scrubHomePath(input.error.stack)) : undefined,
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
        // TODO(v0.3-supervisor): producer wired when supervisor publishes health pings (spec §5.3, §9).
        // Until then DaemonChildHandle.lastHealthzAt is never set, so this field is always null.
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

  function pruneRetention(pruneOpts: PruneOpts): void {
    const { maxCount, maxAgeDays, maxPerSurface, protectUnsentYoungerThanDays, maxAggregateBytes } = pruneOpts;

    interface Entry { name: string; full: string; mtime: number; surface: string | null; protected: boolean; bytes: number }

    let entries: Entry[];
    try {
      entries = fs.readdirSync(opts.crashRoot)
        .filter(n => !n.startsWith('_') && !n.startsWith('.'))
        .map<Entry | null>((n) => {
          const full = path.join(opts.crashRoot, n);
          let stat: fs.Stats;
          try { stat = fs.statSync(full); } catch { return null; }
          if (!stat.isDirectory()) return null;
          let surface: string | null = null;
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(full, 'meta.json'), 'utf8')) as { surface?: string };
            surface = meta.surface ?? null;
          } catch {
            // Incident dir without meta — treat as unknown-surface; still subject to global rules.
          }
          const isUploaded = fs.existsSync(path.join(full, '.uploaded'));
          let protectedByWindow = false;
          if (protectUnsentYoungerThanDays != null && !isUploaded) {
            const cutoff = Date.now() - protectUnsentYoungerThanDays * 24 * 3600 * 1000;
            if (stat.mtimeMs >= cutoff) protectedByWindow = true;
          }
          const bytes = computeDirBytes(full);
          return { name: n, full, mtime: stat.mtimeMs, surface, protected: protectedByWindow, bytes };
        })
        .filter((x): x is Entry => x !== null);
    } catch {
      return;
    }

    const toDelete = new Set<string>();

    // Phase 1 / legacy global rule: prune entries that are BOTH older than
    // maxAgeDays AND beyond the newest maxCount. Kept for backward-compat
    // when callers don't pass maxPerSurface.
    if (maxCount != null && maxAgeDays != null) {
      const cutoff = Date.now() - maxAgeDays * 24 * 3600 * 1000;
      const sorted = [...entries].sort((a, b) => b.mtime - a.mtime); // newest first
      for (let i = 0; i < sorted.length; i++) {
        const e = sorted[i]!;
        if (i >= maxCount && e.mtime < cutoff && !e.protected) {
          toDelete.add(e.full);
        }
      }
    }

    // Phase 5 per-surface keep-N rule.
    if (maxPerSurface != null) {
      const bySurface = new Map<string, Entry[]>();
      for (const e of entries) {
        const key = e.surface ?? '__unknown__';
        const arr = bySurface.get(key) ?? [];
        arr.push(e);
        bySurface.set(key, arr);
      }
      for (const arr of bySurface.values()) {
        arr.sort((a, b) => b.mtime - a.mtime); // newest first
        for (let i = maxPerSurface; i < arr.length; i++) {
          const e = arr[i]!;
          if (!e.protected) toDelete.add(e.full);
        }
      }
    }

    // Spec frag-6-7 §6.6.3: aggregate per-side byte cap (default 200 MB at
    // call site). Sum surviving (post-other-rules) incident sizes oldest-first
    // and delete the oldest until total is under the cap. Protected-unsent
    // incidents are NEVER deleted to satisfy the cap; if removing every
    // unprotected candidate still leaves us above the cap, we log warn and
    // skip — the protect-unsent invariant wins (Task #59 dispatch).
    if (maxAggregateBytes != null) {
      const surviving = entries.filter(e => !toDelete.has(e.full));
      let total = surviving.reduce((s, e) => s + e.bytes, 0);
      if (total > maxAggregateBytes) {
        // Walk oldest-first; only unprotected can be deleted.
        const oldestFirst = [...surviving].sort((a, b) => a.mtime - b.mtime);
        for (const e of oldestFirst) {
          if (total <= maxAggregateBytes) break;
          if (e.protected) continue;
          toDelete.add(e.full);
          total -= e.bytes;
        }
        if (total > maxAggregateBytes) {
          // Couldn't get under the cap without touching protected dirs.
          const protectedBytes = oldestFirst
            .filter(e => e.protected && !toDelete.has(e.full))
            .reduce((s, e) => s + e.bytes, 0);
          console.warn(
            `[crash-collector] aggregate cap ${maxAggregateBytes}B exceeded ` +
            `(post-prune total=${total}B, protected-unsent=${protectedBytes}B); ` +
            `skipping protected-unsent incidents per spec frag-6-7 §6.6.3.`,
          );
        }
      }
    }

    for (const full of toDelete) {
      try { fs.rmSync(full, { recursive: true, force: true }); } catch { /* best-effort */ }
    }
  }

  async function flush(): Promise<void> { /* sentry flush hooked in phase 2 */ }

  return { recordIncident, flush, pruneRetention };
}
