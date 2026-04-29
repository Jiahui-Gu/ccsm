import type { Session } from '../../types';

// Default-name placeholders that backfill is allowed to overwrite. The store
// always writes the English literal at create time; '新会话' is included
// because older persisted snapshots from a Chinese-locale build (when
// `createSession` briefly localized the name) may still carry it. Anything
// else (user rename, prior backfill) is treated as authoritative.
export const BACKFILL_DEFAULT_NAMES: ReadonlySet<string> = new Set<string>([
  'New session',
  '新会话',
]);

// Pure decider for `_backfillTitles`: groups sessions still using a default
// name by their projectKey, so the action can issue ONE IPC call per project
// instead of per session. projectKey encoding mirrors the CLI's
// `~/.claude/projects/<key>/<sid>.jsonl` convention: every `\` `/` `:`
// becomes `-`. Sessions with a non-default name or empty cwd are excluded.
export function partitionSessionsForBackfill(
  sessions: ReadonlyArray<Session>,
): Map<string, string[]> {
  const byProject = new Map<string, string[]>();
  for (const s of sessions) {
    if (!BACKFILL_DEFAULT_NAMES.has(s.name)) continue;
    if (typeof s.cwd !== 'string' || s.cwd.length === 0) continue;
    const key = s.cwd.replace(/[\\/:]/g, '-');
    const list = byProject.get(key);
    if (list) list.push(s.id);
    else byProject.set(key, [s.id]);
  }
  return byProject;
}
