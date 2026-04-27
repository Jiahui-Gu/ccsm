// Format `(now - startedAt)` as a short monospace string. <100s → "12.3s",
// <100min → "2:34" (mm:ss), ≥100min → "1h23m" so the counter never grows
// wider than ~5 chars and doesn't shove the collapse chevron around.
export function formatElapsed(ms: number): string {
  if (ms < 0) ms = 0;
  const s = ms / 1000;
  if (s < 100) return `${s.toFixed(1)}s`;
  const totalSec = Math.floor(s);
  if (totalSec < 100 * 60) {
    const m = Math.floor(totalSec / 60);
    const r = totalSec % 60;
    return `${m}:${String(r).padStart(2, '0')}`;
  }
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  return `${h}h${String(m).padStart(2, '0')}m`;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
