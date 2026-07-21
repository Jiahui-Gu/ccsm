import type {
  NavigationMetadataSnapshot,
  SessionNavigatorGroup,
  SessionNavigatorModel,
  SessionNavigatorState,
} from './types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeState(
  value: Record<string, unknown>,
  sessionId: string,
  activeId: string | null,
): SessionNavigatorState {
  if (sessionId === activeId) return 'active';
  if (value.state === 'waiting') return 'waiting';
  return 'idle';
}

export function buildSessionNavigatorModel(
  snapshot: NavigationMetadataSnapshot,
  liveSessionIds: ReadonlySet<string>,
): SessionNavigatorModel {
  const groups = Array.isArray(snapshot.groups) ? snapshot.groups : [];
  const sessions = Array.isArray(snapshot.sessions) ? snapshot.sessions : [];
  const activeId =
    typeof snapshot.activeId === 'string' && liveSessionIds.has(snapshot.activeId)
      ? snapshot.activeId
      : null;

  const validGroups: SessionNavigatorGroup[] = groups.flatMap((value, order): SessionNavigatorGroup[] => {
    if (!isRecord(value) || value.kind !== 'normal') return [];
    if (typeof value.id !== 'string' || typeof value.name !== 'string') return [];
    return [{
      id: value.id,
      name: value.name || value.id,
      order,
      collapsed: value.collapsed === true,
      sessions: [],
    }];
  });

  const byGroup = new Map(validGroups.map((group) => [group.id, group]));
  sessions.forEach((value, order) => {
    if (!isRecord(value) || typeof value.id !== 'string' || !liveSessionIds.has(value.id)) return;
    if (typeof value.groupId !== 'string' || typeof value.cwd !== 'string') return;
    const group = byGroup.get(value.groupId);
    if (!group) return;
    group.sessions.push({
      id: value.id,
      name: typeof value.name === 'string' && value.name ? value.name : value.id,
      cwd: value.cwd,
      state: normalizeState(value, value.id, activeId),
      order,
    });
  });

  return {
    groups: validGroups.filter((group) => group.sessions.length > 0),
    activeSessionId: activeId,
  };
}
