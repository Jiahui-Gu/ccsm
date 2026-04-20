import { describe, it, expect } from 'vitest';
import { bucketForDate, bucketize } from '../src/utils/date-buckets';

// Reference "now": 2026-04-21 14:00 local.
const NOW = new Date(2026, 3, 21, 14, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

describe('bucketForDate', () => {
  it('today: same calendar day', () => {
    expect(bucketForDate(new Date(2026, 3, 21, 0, 1).getTime(), NOW)).toBe('today');
    expect(bucketForDate(new Date(2026, 3, 21, 13, 59).getTime(), NOW)).toBe('today');
  });

  it('yesterday: previous calendar day', () => {
    expect(bucketForDate(new Date(2026, 3, 20, 23, 59).getTime(), NOW)).toBe('yesterday');
    expect(bucketForDate(new Date(2026, 3, 20, 0, 0).getTime(), NOW)).toBe('yesterday');
  });

  it('week: 2–6 days ago', () => {
    expect(bucketForDate(NOW - 2 * DAY, NOW)).toBe('week');
    expect(bucketForDate(NOW - 6 * DAY, NOW)).toBe('week');
  });

  it('month: 7–29 days ago', () => {
    expect(bucketForDate(NOW - 7 * DAY, NOW)).toBe('month');
    expect(bucketForDate(NOW - 29 * DAY, NOW)).toBe('month');
  });

  it('older: 30+ days ago', () => {
    expect(bucketForDate(NOW - 30 * DAY, NOW)).toBe('older');
    expect(bucketForDate(new Date(2020, 0, 1).getTime(), NOW)).toBe('older');
  });
});

describe('bucketize', () => {
  it('groups items and skips empty buckets', () => {
    const items = [
      { id: 'a', mtime: new Date(2026, 3, 21, 10, 0).getTime() }, // today
      { id: 'b', mtime: new Date(2026, 3, 20, 10, 0).getTime() }, // yesterday
      { id: 'c', mtime: new Date(2020, 0, 1).getTime() } // older
    ];
    const buckets = bucketize(items, NOW);
    expect(buckets.map((b) => b.key)).toEqual(['today', 'yesterday', 'older']);
    expect(buckets[0].items.map((i) => i.id)).toEqual(['a']);
    expect(buckets[2].items.map((i) => i.id)).toEqual(['c']);
  });

  it('sorts within bucket by mtime desc', () => {
    const items = [
      { id: 'a', mtime: new Date(2026, 3, 21, 8, 0).getTime() },
      { id: 'b', mtime: new Date(2026, 3, 21, 12, 0).getTime() },
      { id: 'c', mtime: new Date(2026, 3, 21, 2, 0).getTime() }
    ];
    const buckets = bucketize(items, NOW);
    expect(buckets[0].items.map((i) => i.id)).toEqual(['b', 'a', 'c']);
  });

  it('returns empty list when no items', () => {
    expect(bucketize([], NOW)).toEqual([]);
  });
});
