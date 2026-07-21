import './sessionNavigator.css';

import type { SessionNavigatorDensity, SessionNavigatorGroup, SessionNavigatorModel, SessionNavigatorSession } from './types';
import { SessionGroupHeader } from './SessionGroupHeader';
import { SessionNavigatorItem } from './SessionNavigatorItem';

export type SessionNavigatorProps = {
  model: SessionNavigatorModel;
  collapsedGroups: ReadonlySet<string>;
  onToggleGroup: (id: string) => void;
  onSelectSession: (id: string) => void;
  density?: SessionNavigatorDensity;
};

function sortByOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.order - right.order);
}

function isCollapsed(group: SessionNavigatorGroup, collapsedGroups: ReadonlySet<string>): boolean {
  return collapsedGroups.has(group.id) || (!collapsedGroups.size && group.collapsed);
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
