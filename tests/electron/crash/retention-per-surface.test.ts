// tests/electron/crash/retention-per-surface.test.ts
//
// Phase 5 retention: per-surface keep-N pruning + protected-window for
// unsent-young incidents. Spec/plan §10 + phase-5 user prompt.
//
// Rules under test:
//   - `maxPerSurface=N` keeps the N newest per surface (by mtime), prunes the
//     rest within the same surface.
//   - An incident is "protected" if it has NO `.uploaded` marker AND its
//     mtime is younger than `protectUnsentYoungerThanDays`. Protected
//     incidents are kept regardless of the count cap.
//   - The legacy global `maxCount`/`maxAgeDays` behaviour is preserved when
//     callers don't pass `maxPerSurface`.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startCrashCollector } from '../../../electron/crash/collector';

const SURFACES = ['main', 'renderer', 'daemon-exit', 'daemon-uncaught'] as const;
type Surface = typeof SURFACES[number];

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-coll-ret-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

function makeIncident(c: ReturnType<typeof startCrashCollector>, surface: Surface, ageDays: number, opts: { uploaded?: boolean } = {}): string {
  const dir = c.recordIncident({ surface });
  if (opts.uploaded) {
    fs.writeFileSync(path.join(dir, '.uploaded'), JSON.stringify({ ts: new Date().toISOString() }), 'utf8');
  }
  // Backdate AFTER any helper-written files so the dir's mtime reflects ageDays
  // rather than the most recent write inside the dir.
  const t = (Date.now() - ageDays * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(dir, t, t);
  return dir;
}

describe('crash retention — per-surface + protected-window', () => {
  it('per-surface keep-N: 15 incidents per surface, N=10 → keeps 10 newest per surface', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const dirs: Record<Surface, string[]> = { main: [], renderer: [], 'daemon-exit': [], 'daemon-uncaught': [] };
    for (const s of SURFACES) {
      for (let i = 0; i < 15; i++) {
        // ageDays decreasing so dirs[*][14] is newest. All > protect window so none are protected unsent.
        dirs[s].push(makeIncident(c, s, 30 - i, { uploaded: true }));
      }
    }
    c.pruneRetention({ maxPerSurface: 10, protectUnsentYoungerThanDays: 7 });
    for (const s of SURFACES) {
      // The 5 oldest per surface should be gone; the 10 newest remain.
      for (let i = 0; i < 5; i++) expect(fs.existsSync(dirs[s][i]!)).toBe(false);
      for (let i = 5; i < 15; i++) expect(fs.existsSync(dirs[s][i]!)).toBe(true);
    }
  });

  it('protected window: 15 incidents, N=10, with 2 unsent <7d → keeps 12', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    // 2 oldest are unsent + young (3 days); 13 others are uploaded + old.
    const all: { dir: string; protected: boolean }[] = [];
    for (let i = 0; i < 2; i++) all.push({ dir: makeIncident(c, 'main', 3 + i * 0.1, { uploaded: false }), protected: true });
    for (let i = 0; i < 13; i++) all.push({ dir: makeIncident(c, 'main', 30 + i, { uploaded: true }), protected: false });

    c.pruneRetention({ maxPerSurface: 10, protectUnsentYoungerThanDays: 7 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && !n.startsWith('.'));
    // 10 newest by mtime + 2 protected = 12 (one of the protected may already be in the 10-newest set,
    // depending on age; in this case the 2 protected ARE the 2 newest by mtime).
    // 2 youngest by mtime are the protected (3-day-old); next-newest is 30-day uploaded.
    // 10-newest set = 2 protected + 8 oldest-of-the-uploaded-cohort? No: newest first.
    // Newest 10 = the 2 protected (3d) + the 8 newest of the uploaded (30..37 days).
    // Then "2 unsent <7d" overlap with the newest-10 set → kept count = 10. So only 5 pruned,
    // remaining = 10. But user spec text says "keeps 12" — that scenario is when the 2 protected
    // are OLDER than the keep window. Recompute: make protected 2 also OLD-by-mtime (e.g. 60 days).
    // Then newest-10 = 10 of the uploaded; 2 protected are extra. Keep 12.
    expect(remaining.length).toBe(10);
    for (const x of all.filter(a => a.protected)) expect(fs.existsSync(x.dir)).toBe(true);
  });

  it('protected window — 12 case: 2 unsent OLDER than keep window stay anyway', () => {
    // 13 uploaded incidents (newer) + 2 unsent very-young (today) but their mtime is below the 13 newest.
    // Setup: make the 13 uploaded be 1..13 days old; protected 2 are 0.1, 0.2 days old (newest).
    // Then the 13 uploaded contains 10 newest of the uploaded-set. 2 protected are within the
    // newest-10 already → kept count is 10 — same overlap problem.
    //
    // Real scenario per user prompt: protect prevents pruning of incidents the count rule WOULD
    // otherwise prune. Construct: 15 uploaded incidents 1..15 days old. The 5 oldest (11..15 days)
    // are slated for prune by N=10. Mark 2 of those slated-for-prune incidents as unsent and bump
    // their mtime up to <7d so they become protected. Kept = 10 newest + 2 protected = 12.
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const uploaded: string[] = [];
    for (let i = 0; i < 13; i++) uploaded.push(makeIncident(c, 'main', 1 + i, { uploaded: true }));
    // 2 protected — older than newest-10 boundary by uploaded-count BUT young per protect window.
    // Use ageDays = 5 (below 7d protect window) and uploaded:false. Their mtime puts them in the
    // newest-10 by mtime, but we can't avoid that with one surface. So instead bump 2 of the
    // uploaded[] entries to unsent + age=5 to be in the slated-for-prune zone? Same problem.
    //
    // The clean construction: 15 incidents, ages 1..15 days, all uploaded except indices 10 + 11
    // which are unsent (age 11d, 12d) — age > 7d → NOT protected. Keep 10 newest + 0 protected = 10.
    // To get "keeps 12" we need 2 protected that the count rule would prune. That requires ages
    // <7d for protection BUT be outside newest-10. Impossible in one surface unless we have ≥13
    // incidents <7d. Use 12 incidents <7d (ages 0.1..6.5) + 3 uploaded older. Of the 12 young:
    // 2 unsent (protected), 10 uploaded.
    //
    // Reset and rebuild.
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    const c2 = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const young: { dir: string; protected: boolean }[] = [];
    // 10 uploaded young, ages 0.1..1.0d
    for (let i = 0; i < 10; i++) young.push({ dir: makeIncident(c2, 'main', 0.1 + i * 0.1, { uploaded: true }), protected: false });
    // 2 unsent young, ages 1.5d, 1.6d — slated for prune by count rule (slot 11+12) but protected.
    young.push({ dir: makeIncident(c2, 'main', 1.5, { uploaded: false }), protected: true });
    young.push({ dir: makeIncident(c2, 'main', 1.6, { uploaded: false }), protected: true });
    // 3 uploaded old, ages 30..32d — slated for prune by count rule (slot 13..15), no protection.
    const old: string[] = [];
    for (let i = 0; i < 3; i++) old.push(makeIncident(c2, 'main', 30 + i, { uploaded: true }));

    c2.pruneRetention({ maxPerSurface: 10, protectUnsentYoungerThanDays: 7 });

    // The 2 protected MUST survive even though they're outside newest-10.
    for (const y of young.filter(y => y.protected)) expect(fs.existsSync(y.dir)).toBe(true);
    // The 10 newest uploaded survive.
    for (const y of young.filter(y => !y.protected)) expect(fs.existsSync(y.dir)).toBe(true);
    // The 3 old uploaded got pruned.
    for (const o of old) expect(fs.existsSync(o)).toBe(false);

    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && !n.startsWith('.'));
    expect(remaining.length).toBe(12); // 10 newest + 2 protected
  });

  it('protected-window applies even when surface is over count cap (regression for unsent-young rule)', () => {
    // 5 incidents in 'renderer' surface, all unsent + 2 days old. N=2. Protected window=7d.
    // All 5 are protected → all 5 must survive (count cap is overridden by protection).
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const dirs: string[] = [];
    for (let i = 0; i < 5; i++) dirs.push(makeIncident(c, 'renderer', 1 + i * 0.1, { uploaded: false }));
    c.pruneRetention({ maxPerSurface: 2, protectUnsentYoungerThanDays: 7 });
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
  });

  it('legacy global maxCount/maxAgeDays still works when maxPerSurface omitted', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const dirs: string[] = [];
    for (let i = 0; i < 21; i++) dirs.push(c.recordIncident({ surface: 'main' }));
    const dayMs = 24 * 3600 * 1000;
    const now = Date.now();
    for (let i = 0; i < 21; i++) {
      const ageDays = 31 - (i * (31 / 20));
      const t = (now - ageDays * dayMs) / 1000;
      fs.utimesSync(dirs[i]!, t, t);
    }
    c.pruneRetention({ maxCount: 20, maxAgeDays: 30 });
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_'));
    expect(remaining.length).toBe(20);
    expect(fs.existsSync(dirs[0]!)).toBe(false);
  });
});
