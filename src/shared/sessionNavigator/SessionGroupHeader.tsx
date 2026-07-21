import { useCallback } from 'react';
import type { CSSProperties, MouseEvent, ReactNode } from 'react';

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

export type SessionGroupHeaderBodyProps = {
  group: SessionNavigatorGroup;
  expanded: boolean;
  /**
   * Optional handler wired onto the group label span. Lets a platform host
   * (e.g. the desktop GroupRow) trigger inline rename on double-click
   * without the shared body owning any rename state itself.
   */
  onLabelDoubleClick?: (event: MouseEvent<HTMLSpanElement>) => void;
  /** Extra content rendered after the label, before the count (e.g. a "has waiting session" dot). */
  trailing?: ReactNode;
  /** Whether to render the session-count badge. Defaults to true. */
  showCount?: boolean;
  /**
   * When provided, replaces the label/trailing/count region entirely (e.g.
   * an inline-rename input in place of the static label). The chevron is
   * still rendered so the expand/collapse affordance stays visible while a
   * host is mid-rename. Used by the desktop GroupRow.
   */
  labelSlot?: ReactNode;
};

/**
 * Renders the chevron + label + count shared by the desktop and touch
 * session navigators. Intentionally has no outer <button> so host
 * components (SessionGroupHeader below, or a platform-specific row) can own
 * their own button element, droppable/menu wiring, and refs.
 */
export function SessionGroupHeaderBody({
  group,
  expanded,
  onLabelDoubleClick,
  trailing,
  showCount = true,
  labelSlot,
}: SessionGroupHeaderBodyProps) {
  return (
    <>
      <span aria-hidden="true" className="ccsm-session-navigator__chevron" data-expanded={expanded}>
        ▸
      </span>
      {labelSlot ?? (
        <>
          <span
            className="ccsm-session-navigator__group-label"
            title={group.name}
            onDoubleClick={onLabelDoubleClick}
          >
            {group.name}
          </span>
          {trailing}
          {showCount && (
            <span className="ccsm-session-navigator__group-count" aria-hidden="true">
              {group.sessions.length}
            </span>
          )}
        </>
      )}
    </>
  );
}

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
      <SessionGroupHeaderBody group={group} expanded={expanded} />
    </button>
  );
}
