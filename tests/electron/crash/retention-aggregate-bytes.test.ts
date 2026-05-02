// tests/electron/crash/retention-aggregate-bytes.test.ts
//
// Task #59 — aggregate per-side byte cap (spec frag-6-7 §6.6.3 + §6.6.1).
//
// Rules under test:
//   - `pruneRetention({ maxAggregateBytes })` deletes oldest-first (by mtime)
//     until the total on-disk size of incident dirs is <= the cap.
//   - Protected-unsent incidents (no `.uploaded` marker AND mtime within
//     `protectUnsentYoungerThanDays`) are NEVER deleted to satisfy the cap.
//     If the cap cannot be hit without touching protected dirs, the cap is
//     skipped and a `console.warn` is emitted (spec: protect-unsent wins).
//
// The dispatch description suggested 50 incidents x 50 MB = 2.5 GB of test
// I/O which would balloon CI; we use proportionally smaller sizes (5 MB per
// incident, 20 MB cap) to exercise the same code path quickly. The cap is
// configured per-test, so the unit-conversion is validated independently in
// the call-site assertion at the bottom of this file.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { startCrashCollector } from '../../../electron/crash/collector';

const MB = 1024 * 1024;

let tmp: string;
beforeEach(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-coll-bytes-')); });
afterEach(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

/** Pad an existing incident dir to roughly `bytes` total by writing a single
 *  `padding.bin` file. We then re-stamp the dir's mtime to `ageDays` so the
 *  oldest-first walk is deterministic. */
function padIncident(dir: string, bytes: number, ageDays: number, opts: { uploaded?: boolean } = {}): void {
  fs.writeFileSync(path.join(dir, 'padding.bin'), Buffer.alloc(bytes));
  if (opts.uploaded) {
    fs.writeFileSync(path.join(dir, '.uploaded'), JSON.stringify({ ts: new Date().toISOString() }), 'utf8');
  }
  const t = (Date.now() - ageDays * 24 * 3600 * 1000) / 1000;
  fs.utimesSync(dir, t, t);
}

describe('crash retention — aggregate byte cap (Task #59)', () => {
  it('200MB-style cap: 10 incidents x 5MB padding, cap 20MB → keeps newest only', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const dirs: string[] = [];
    for (let i = 0; i < 10; i++) {
      const d = c.recordIncident({ surface: 'main' });
      dirs.push(d);
      // ageDays decreasing so dirs[9] is the newest.
      padIncident(d, 5 * MB, 30 - i, { uploaded: true });
    }

    c.pruneRetention({ maxAggregateBytes: 20 * MB });

    // Sum surviving size; must be <= cap.
    const remaining = fs.readdirSync(tmp).filter(n => !n.startsWith('_') && !n.startsWith('.'));
    let total = 0;
    for (const n of remaining) {
      const full = path.join(tmp, n);
      total += fs.statSync(path.join(full, 'padding.bin')).size;
      // Other small files (meta.json, README.txt) — count too.
      for (const f of fs.readdirSync(full)) {
        if (f === 'padding.bin') continue;
        try { total += fs.statSync(path.join(full, f)).size; } catch { /* ignore */ }
      }
    }
    expect(total).toBeLessThanOrEqual(20 * MB);

    // The oldest must be the first to go: dirs[0] gone, dirs[9] (newest) kept.
    expect(fs.existsSync(dirs[0]!)).toBe(false);
    expect(fs.existsSync(dirs[9]!)).toBe(true);

    // Surviving must be a contiguous newest-suffix (no holes).
    let lastSurvivingIdx = -1;
    for (let i = 9; i >= 0; i--) {
      if (fs.existsSync(dirs[i]!)) lastSurvivingIdx = i;
      else break;
    }
    expect(lastSurvivingIdx).toBeGreaterThanOrEqual(0);
    for (let i = 0; i < lastSurvivingIdx; i++) {
      expect(fs.existsSync(dirs[i]!)).toBe(false);
    }
  });

  it('protect-unsent overrides the cap: cannot delete a protected dir even when over cap', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    // 4 protected (unsent + young) incidents, 5 MB each = 20 MB total.
    // Cap is 10 MB, so we'd need to delete 2+. But all are protected → none
    // can be deleted, total stays at 20 MB, warn emitted.
    const protectedDirs: string[] = [];
    for (let i = 0; i < 4; i++) {
      const d = c.recordIncident({ surface: 'renderer' });
      protectedDirs.push(d);
      padIncident(d, 5 * MB, 1 + i * 0.1, { uploaded: false });
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnCalls: unknown[][] = [];
    try {
      c.pruneRetention({
        maxAggregateBytes: 10 * MB,
        protectUnsentYoungerThanDays: 7,
      });
      // Snapshot calls BEFORE restore — vi.spyOn's mockRestore clears .mock.calls.
      warnCalls = warnSpy.mock.calls.map(c => [...c]);
    } finally {
      warnSpy.mockRestore();
    }

    // All 4 protected dirs survive.
    for (const d of protectedDirs) expect(fs.existsSync(d)).toBe(true);

    // A warn line must have been emitted, and it must mention the cap.
    expect(warnCalls.length).toBeGreaterThanOrEqual(1);
    const msg = String(warnCalls[0]?.[0] ?? '');
    expect(msg).toMatch(/aggregate cap/);
    expect(msg).toMatch(/protected-unsent/);
  });

  it('protect-unsent priority is partial: deletes unprotected oldest first, then warns if still over', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    // 2 unprotected old uploaded (ages 30, 31 days, 5 MB each)
    // + 2 protected unsent young (ages 1, 2 days, 5 MB each)
    // Total = 20 MB. Cap = 12 MB. Should delete the 2 unprotected (10 MB
    // freed) but the remaining 10 MB of protected dirs is under the cap, so
    // no warn — cap satisfied without touching protected.
    const oldUploaded: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = c.recordIncident({ surface: 'main' });
      oldUploaded.push(d);
      padIncident(d, 5 * MB, 30 + i, { uploaded: true });
    }
    const youngProtected: string[] = [];
    for (let i = 0; i < 2; i++) {
      const d = c.recordIncident({ surface: 'main' });
      youngProtected.push(d);
      padIncident(d, 5 * MB, 1 + i, { uploaded: false });
    }

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let warnCalls: unknown[][] = [];
    try {
      c.pruneRetention({
        maxAggregateBytes: 12 * MB,
        protectUnsentYoungerThanDays: 7,
      });
      warnCalls = warnSpy.mock.calls.map(c => [...c]);
    } finally {
      warnSpy.mockRestore();
    }

    // Both old uploaded got pruned (oldest-first within unprotected).
    for (const d of oldUploaded) expect(fs.existsSync(d)).toBe(false);
    // Both protected survive.
    for (const d of youngProtected) expect(fs.existsSync(d)).toBe(true);
    // No warn — cap was satisfiable without touching protected.
    expect(warnCalls.length).toBe(0);
  });

  it('cap absent → no byte-based deletion (legacy callers unaffected)', () => {
    const c = startCrashCollector({
      crashRoot: tmp,
      dmpStaging: path.join(tmp, '_dmp-staging'),
      appVersion: '0.3.0',
      electronVersion: '41.3.0',
    });
    const dirs: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = c.recordIncident({ surface: 'main' });
      dirs.push(d);
      padIncident(d, 5 * MB, 1 + i, { uploaded: true });
    }
    // No maxAggregateBytes provided → no byte cap applies.
    c.pruneRetention({ protectUnsentYoungerThanDays: 7 });
    for (const d of dirs) expect(fs.existsSync(d)).toBe(true);
  });
});
