import { useCallback } from 'react';
import type { CSSProperties } from 'react';

import type { SessionNavigatorDensity, SessionNavigatorGroup } from './types';

const ROW_MIN_HEIGHT: Record<SessionNavigatorDensity, number> = {
  desktop: 36,
  touch: 44,
};

export type SessionGroupHeaderProps = {
  group: SessionNavigatorGroup;
  expanded: boolean;
  onToggle: (id: string) => void;
  density?: SessionNavigatorDensity;
  controlsId?: string;
};

export function SessionGroupHeader({
  group,
  expanded,
  onToggle,
  density = 'desktop',
  controlsId,
}: SessionGroupHeaderProps) {
  const style: CSSProperties = { minHeight: `${ROW_MIN_HEIGHT[density]}px` };

  const handleClick = useCallback(() => {
    onToggle(group.id);
  }, [group.id, onToggle]);

  return (
    <button
      type="button"
      aria-expanded={expanded}
      aria-controls={controlsId}
      data-expanded={expanded}
      style={style}
      className="ccsm-session-navigator__group-button"
      onClick={handleClick}
    >
      <span aria-hidden="true" className="ccsm-session-navigator__chevron">
        ▸
      </span>
      <span className="ccsm-session-navigator__group-label" title={group.name}>
        {group.name}
      </span>
      <span className="ccsm-session-navigator__group-count" aria-hidden="true">
        {group.sessions.length}
      </span>
    </button>
  );
}
