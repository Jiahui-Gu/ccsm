// packages/daemon/test/crash/pruner-decider.spec.ts
//
// Pure decider tests for the crash retention pruner (Task #64 / T5.12).
// No SQLite, no clock — verifies the (now, settings) → PrunePlan mapping
// and the hard-cap clamping rules.

import { describe, expect, it } from 'vitest';

import {
  MAX_AGE_DAYS_HARD_CAP,
  MAX_ENTRIES_HARD_CAP,
  decidePrune,
  resolveRetention,
} from '../../src/crash/pruner-decider.js';

describe('resolveRetention (T5.12 — ch09 §3 defaults + clamping)', () => {
  it('falls back to defaults when settings are empty', () => {
    const r = resolveRetention({});
    expect(r.maxEntries).toBe(MAX_ENTRIES_HARD_CAP);
    expect(r.maxAgeDays).toBe(MAX_AGE_DAYS_HARD_CAP);
    expect(r.maxEntriesClamped).toBe(false);
    expect(r.maxAgeDaysClamped).toBe(false);
  });

  it('honours user-supplied values inside the hard cap', () => {
    const r = resolveRetention({ max_entries: 500, max_age_days: 14 });
    expect(r.maxEntries).toBe(500);
    expect(r.maxAgeDays).toBe(14);
    expect(r.maxEntriesClamped).toBe(false);
    expect(r.maxAgeDaysClamped).toBe(false);
  });

  it('clamps user-supplied values above the hard cap and flags it', () => {
    const r = resolveRetention({ max_entries: 50_000, max_age_days: 365 });
    expect(r.maxEntries).toBe(MAX_ENTRIES_HARD_CAP);
    expect(r.maxAgeDays).toBe(MAX_AGE_DAYS_HARD_CAP);
    expect(r.maxEntriesClamped).toBe(true);
    expect(r.maxAgeDaysClamped).toBe(true);
  });

  it('treats zero / negative / NaN as "use default" (not clamp)', () => {
    const r = resolveRetention({ max_entries: 0, max_age_days: -5 });
    expect(r.maxEntries).toBe(MAX_ENTRIES_HARD_CAP);
    expect(r.maxAgeDays).toBe(MAX_AGE_DAYS_HARD_CAP);
    expect(r.maxEntriesClamped).toBe(false);
    expect(r.maxAgeDaysClamped).toBe(false);
  });

  it('floors fractional max_age_days', () => {
    const r = resolveRetention({ max_age_days: 7.9 });
    expect(r.maxAgeDays).toBe(7);
  });

  it('clamps a value EQUAL to the hard cap without flagging (no-op)', () => {
    const r = resolveRetention({
      max_entries: MAX_ENTRIES_HARD_CAP,
      max_age_days: MAX_AGE_DAYS_HARD_CAP,
    });
    expect(r.maxEntries).toBe(MAX_ENTRIES_HARD_CAP);
    expect(r.maxAgeDays).toBe(MAX_AGE_DAYS_HARD_CAP);
    expect(r.maxEntriesClamped).toBe(false);
    expect(r.maxAgeDaysClamped).toBe(false);
  });
});

describe('decidePrune (T5.12 — ch09 §3 plan)', () => {
  const NOW = 1_714_600_000_000; // arbitrary but stable
  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  it('emits an age-cutoff = now - maxAgeDays * 86400000', () => {
    const plan = decidePrune(NOW, { max_age_days: 30 });
    expect(plan.ageCutoffMs).toBe(NOW - 30 * MS_PER_DAY);
    expect(plan.ageDelete.param).toBe(NOW - 30 * MS_PER_DAY);
  });

  it('emits a count-cutoff = effective.maxEntries', () => {
    const plan = decidePrune(NOW, { max_entries: 750 });
    expect(plan.countDelete.param).toBe(750);
  });

  it('targets crash_log in both DELETEs', () => {
    const plan = decidePrune(NOW, {});
    expect(plan.ageDelete.sql).toMatch(/^DELETE FROM crash_log WHERE ts_ms < \?$/);
    expect(plan.countDelete.sql).toContain('DELETE FROM crash_log');
    // Order tie-break by id so the keep-set is deterministic when many
    // rows share a ts_ms.
    expect(plan.countDelete.sql).toContain('ORDER BY ts_ms DESC, id DESC');
    expect(plan.countDelete.sql).toContain('LIMIT ?');
  });

  it('clamps a too-large max_entries and surfaces it via .effective', () => {
    const plan = decidePrune(NOW, { max_entries: 99_999 });
    expect(plan.effective.maxEntries).toBe(MAX_ENTRIES_HARD_CAP);
    expect(plan.effective.maxEntriesClamped).toBe(true);
    expect(plan.countDelete.param).toBe(MAX_ENTRIES_HARD_CAP);
  });

  it('uses defaults (10000 / 90) when settings are absent', () => {
    const plan = decidePrune(NOW, {});
    expect(plan.effective.maxEntries).toBe(10_000);
    expect(plan.effective.maxAgeDays).toBe(90);
    expect(plan.ageDelete.param).toBe(NOW - 90 * MS_PER_DAY);
    expect(plan.countDelete.param).toBe(10_000);
  });

  it('is pure — same inputs always produce the same plan', () => {
    const a = decidePrune(NOW, { max_entries: 100, max_age_days: 7 });
    const b = decidePrune(NOW, { max_entries: 100, max_age_days: 7 });
    expect(a).toEqual(b);
  });
});
