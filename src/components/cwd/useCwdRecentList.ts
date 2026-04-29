import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

const RECENT_LIMIT = 10;

async function defaultLoadRecent(): Promise<string[]> {
  type Bridge = { recentCwds?: () => Promise<string[]> };
  const bridge =
    typeof window !== 'undefined'
      ? (window as unknown as { ccsm?: Bridge }).ccsm
      : undefined;
  try {
    const list = await bridge?.recentCwds?.();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

export type UseCwdRecentListResult = {
  /** Filtered recent entries — `recent` narrowed by `query`. */
  filtered: string[];
  /** Current input value. */
  query: string;
  setQuery: (q: string) => void;
  /** Active row index into `filtered`. */
  active: number;
  setActive: (a: number | ((prev: number) => number)) => void;
  /** ArrowUp/ArrowDown/Enter handler for the input. */
  onListKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
};

/**
 * Recent-cwd loader + filter + keyboard navigation hook.
 *
 * - Lazy-loads via `loadRecent` (defaults to the IPC bridge) on each `open` flip.
 * - Resets query + active row each time the popover opens.
 * - Filters `recent` by case-insensitive substring match against `query`.
 * - Keeps `active` clamped within `filtered` length.
 * - `onListKeyDown` provides ArrowUp/ArrowDown to move + Enter to commit
 *   either the highlighted recent entry or the raw query (if non-empty).
 */
export function useCwdRecentList(
  open: boolean,
  loadRecent: (() => Promise<string[]>) | undefined,
  commit: (path: string) => void
): UseCwdRecentListResult {
  const [query, setQuery] = useState('');
  const [recent, setRecent] = useState<string[]>([]);
  const [active, setActive] = useState(0);

  // Reset query each time we re-open so the Recent list shows in full.
  useEffect(() => {
    if (!open) return;
    setQuery('');
    setActive(0);
  }, [open]);

  // Lazy-load recent cwds on each open.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const loader = loadRecent ?? defaultLoadRecent;
    void loader().then((list) => {
      if (cancelled) return;
      setRecent(list.slice(0, RECENT_LIMIT));
    });
    return () => {
      cancelled = true;
    };
  }, [open, loadRecent]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return recent;
    return recent.filter((p) => p.toLowerCase().includes(needle));
  }, [recent, query]);

  // Clamp active row whenever the filtered list shrinks.
  useEffect(() => {
    if (active >= filtered.length) setActive(0);
  }, [filtered.length, active]);

  const onListKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, Math.max(0, filtered.length - 1)));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(0, a - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const choice = filtered[active] ?? (query.trim() ? query.trim() : null);
        if (choice) commit(choice);
      }
    },
    [active, commit, filtered, query]
  );

  return { filtered, query, setQuery, active, setActive, onListKeyDown };
}
