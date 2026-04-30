import type { Group } from '../../types';

/**
 * Resolve the preferred group id for a new session, BEFORE
 * `ensureUsableGroup` runs its synthesis fallback.
 *
 * Preference order (preserved from the previous inline logic in
 * `createSession`):
 *   1. caller-provided `callerGroupId` (e.g. an explicit `opts.groupId`)
 *   2. the currently focused group
 *   3. the group of the active session
 *   4. null — let `ensureUsableGroup` pick the first normal group or
 *      synthesize a default one.
 *
 * A group is "usable" only when it exists in `groups` AND its `kind` is
 * `'normal'` (archive groups never receive new sessions).
 */
export function resolvePreferredGroup(
  groups: ReadonlyArray<Group>,
  callerGroupId: string | null | undefined,
  focusedGroupId: string | null | undefined,
  activeGroupId: string | null | undefined,
): string | null {
  const isUsable = (gid: string | null | undefined): boolean => {
    if (!gid) return false;
    const g = groups.find((x) => x.id === gid);
    return !!g && g.kind === 'normal';
  };
  if (isUsable(callerGroupId)) return callerGroupId!;
  if (isUsable(focusedGroupId)) return focusedGroupId!;
  if (isUsable(activeGroupId)) return activeGroupId!;
  return null;
}
