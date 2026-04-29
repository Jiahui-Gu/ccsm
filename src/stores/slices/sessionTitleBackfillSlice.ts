// Session title backfill slice: keeps session names in sync with the
// per-project JSONL transcripts the Claude Code CLI writes to
// `~/.claude/projects/<project>/<sid>.jsonl`.
//
// Owned actions:
//   `_applyExternalTitle` — patch a session's `name` from an external
//      source (SDK title bridge IPC, or `_backfillTitles` below). Stable
//      no-op if the name already matches so we don't churn the persisted
//      snapshot or trigger unnecessary re-renders.
//   `_backfillTitles` — one-shot post-hydrate pass that pulls
//      per-project summaries from the SDK and renames any sessions still
//      stuck on a default name (`'New session'` etc.).
//
// CRUD lives on `sessionCrudSlice`; transient runtime state lives on
// `sessionRuntimeSlice` (split per Task #736 / PR #754 review).

import { partitionSessionsForBackfill, BACKFILL_DEFAULT_NAMES } from '../lib/sessionPartition';
import type { RootStore, SetFn, GetFn } from './types';

export type SessionTitleBackfillSlice = Pick<
  RootStore,
  '_applyExternalTitle' | '_backfillTitles'
>;

export function createSessionTitleBackfillSlice(
  set: SetFn,
  get: GetFn,
): SessionTitleBackfillSlice {
  return {
    _applyExternalTitle: (sid, title) => {
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sid);
        if (idx === -1) return s;
        if (s.sessions[idx].name === title) return s;
        const next = s.sessions.slice();
        next[idx] = { ...next[idx], name: title };
        return { ...s, sessions: next };
      });
    },

    _backfillTitles: async () => {
      type Bridge = {
        listForProject: (projectKey: string) => Promise<Array<{
          sid: string;
          summary: string | null;
          mtime: number;
        }>>;
      };
      const bridge =
        typeof window !== 'undefined'
          ? (window as unknown as { ccsmSessionTitles?: Bridge }).ccsmSessionTitles
          : undefined;
      if (!bridge || typeof bridge.listForProject !== 'function') return;

      const byProject = partitionSessionsForBackfill(get().sessions);
      if (byProject.size === 0) return;

      await Promise.all(
        Array.from(byProject.entries()).map(async ([projectKey, sids]) => {
          let summaries: Array<{ sid: string; summary: string | null; mtime: number }>;
          try {
            summaries = await bridge.listForProject(projectKey);
          } catch (err) {
            console.warn('[store._backfillTitles] listForProject failed for', projectKey, err);
            return;
          }
          if (!Array.isArray(summaries)) return;
          const summaryMap = new Map<string, string | null>();
          for (const entry of summaries) {
            if (entry && typeof entry.sid === 'string') {
              summaryMap.set(entry.sid, entry.summary);
            }
          }
          const apply = get()._applyExternalTitle;
          for (const sid of sids) {
            const sum = summaryMap.get(sid);
            if (typeof sum === 'string' && sum.length > 0) {
              const current = get().sessions.find((s) => s.id === sid);
              if (current && BACKFILL_DEFAULT_NAMES.has(current.name)) {
                apply(sid, sum);
              }
            }
          }
        })
      );
    },
  };
}
