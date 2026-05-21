// Session title backfill slice: keeps session names in sync with the
// per-project JSONL transcripts the Claude Code CLI writes to
// `~/.claude/projects/<project>/<sid>.jsonl`.
//
// Owned actions:
//   `_applyExternalTitle` — patch a session's `name` from an external
//      source (SDK title bridge IPC, or `_backfillTitles` below).
//      First-write-wins: only overwrites the default placeholder
//      (`'New session'` etc.). Once a session has a real name (auto
//      from the first turn's OSC title, backfilled summary, or user
//      rename) subsequent external titles are dropped — claude TUI
//      rewrites the window title every prompt, so without this guard
//      the session name flickers turn-to-turn. Stable no-op if the
//      name already matches.
//   `_backfillTitles` — one-shot post-hydrate pass that pulls
//      per-project summaries from the SDK and renames any sessions still
//      stuck on a default name (`'New session'` etc.).
//
// CRUD lives on `sessionCrudSlice`; transient runtime state lives on
// `sessionRuntimeSlice` (split per Task #736 / PR #754 review).

import { partitionSessionsForBackfill, BACKFILL_DEFAULT_NAMES } from '../lib/sessionPartition';
import {
  getPendingManualRename,
  clearPendingManualRename,
} from '../lib/pendingManualRenames';
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
      // Suppress auto-summary writes while a manual rename is awaiting SDK
      // writeback confirmation. The watcher can race the JSONL rewrite and
      // fire `title-changed` with the pre-rename summary; without this
      // guard the user's name flicks back. Clear the guard once we observe
      // an external title equal to the desired name — that proves the
      // round-trip landed.
      const desired = getPendingManualRename(sid);
      if (desired !== undefined) {
        if (title !== desired) return;
        clearPendingManualRename(sid);
      }
      set((s) => {
        const idx = s.sessions.findIndex((x) => x.id === sid);
        if (idx === -1) return s;
        const cur = s.sessions[idx]!.name;
        if (cur === title) return s;
        // First-write-wins on auto naming. The OSC title sniffer in
        // ptyHost emits a fresh title every time the user types a new
        // prompt (claude TUI rewrites the window title each turn);
        // before this guard the session name flickered between turns
        // and any user rename downstream of the initial backfill could
        // be clobbered by the next turn. Only allow external titles to
        // overwrite the *default* placeholder; once the row carries a
        // real name (auto-named on the first turn, or user-renamed via
        // `renameSession`) external titles are dropped.
        if (!BACKFILL_DEFAULT_NAMES.has(cur)) return s;
        const next = s.sessions.slice();
        next[idx] = { ...next[idx]!, name: title };
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
