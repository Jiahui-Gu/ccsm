export type DateBucketKey = 'today' | 'yesterday' | 'week' | 'month' | 'older';

export const BUCKET_LABEL: Record<DateBucketKey, string> = {
  today: 'Today',
  yesterday: 'Yesterday',
  week: 'This week',
  month: 'This month',
  older: 'Older'
};

const BUCKET_ORDER: DateBucketKey[] = ['today', 'yesterday', 'week', 'month', 'older'];

export function bucketForDate(ts: number, now: number = Date.now()): DateBucketKey {
  const start = (d: Date) => {
    const c = new Date(d);
    c.setHours(0, 0, 0, 0);
    return c.getTime();
  };
  const nowDate = new Date(now);
  const startToday = start(nowDate);
  const startYesterday = startToday - 24 * 60 * 60 * 1000;
  const startWeek = startToday - 6 * 24 * 60 * 60 * 1000; // last 7 days incl. today
  const startMonth = startToday - 29 * 24 * 60 * 60 * 1000; // last 30 days

  if (ts >= startToday) return 'today';
  if (ts >= startYesterday) return 'yesterday';
  if (ts >= startWeek) return 'week';
  if (ts >= startMonth) return 'month';
  return 'older';
}

export function bucketize<T extends { mtime: number }>(
  items: T[],
  now: number = Date.now()
): Array<{ key: DateBucketKey; label: string; items: T[] }> {
  const map = new Map<DateBucketKey, T[]>();
  for (const k of BUCKET_ORDER) map.set(k, []);
  for (const it of items) {
    map.get(bucketForDate(it.mtime, now))!.push(it);
  }
  for (const k of BUCKET_ORDER) {
    map.get(k)!.sort((a, b) => b.mtime - a.mtime);
  }
  return BUCKET_ORDER.filter((k) => map.get(k)!.length > 0).map((k) => ({
    key: k,
    label: BUCKET_LABEL[k],
    items: map.get(k)!
  }));
}
