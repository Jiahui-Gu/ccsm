import './sessionNavigator.css';

import type { SessionNavigatorDensity, SessionNavigatorGroup, SessionNavigatorModel, SessionNavigatorSession } from './types';
import { SessionGroupHeader } from './SessionGroupHeader';
import { SessionNavigatorItem } from './SessionNavigatorItem';

export type SessionNavigatorProps = {
  model: SessionNavigatorModel;
  /**
   * The complete, authoritative set of currently-collapsed group ids. This
   * is not merely a diff/override list — a group's id must be present here
   * whenever it should render collapsed, including groups that are only
   * collapsed because of their own persisted `group.collapsed` flag. An
   * empty set unambiguously means "every group is expanded" (there is no
   * size-based fallback onto `group.collapsed`), so callers that need to
   * honor a persisted default must fold it into this set themselves (see
   * `SessionDrawer` for the per-group-override + reconciliation pattern).
   */
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onSelectSession: (id: string) => void;
  density?: SessionNavigatorDensity;
};

function sortByOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.order - right.order);
}

function isCollapsed(group: SessionNavigatorGroup, collapsedGroups: ReadonlySet<string>): boolean {
  return collapsedGroups.has(group.id);
}

export function SessionNavigator({
  model,
  collapsedGroups,
  onToggleGroup,
  onSelectSession,
  density = 'desktop',
}: SessionNavigatorProps) {
  return (
    <div className="ccsm-session-navigator">
      {sortByOrder(model.groups).map((group) => {
        const expanded = !isCollapsed(group, collapsedGroups);
        const sessions = sortByOrder<SessionNavigatorSession>(group.sessions);
        const listId = `ccsm-session-group-${group.id}`;

        return (
          <section key={group.id} className="ccsm-session-navigator__group">
            <SessionGroupHeader
              group={group}
              expanded={expanded}
              onToggle={onToggleGroup}
              density={density}
              controlsId={listId}
            />
            {expanded ? (
              <ul id={listId} role="listbox" aria-label={group.name} className="ccsm-session-navigator__list">
                {sessions.map((session) => (
                  <SessionNavigatorItem
                    key={session.id}
                    session={session}
                    selected={session.id === model.activeSessionId}
                    onSelect={onSelectSession}
                    density={density}
                  />
                ))}
              </ul>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}
