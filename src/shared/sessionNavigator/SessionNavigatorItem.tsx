import { useCallback } from 'react';
import type { CSSProperties, KeyboardEvent } from 'react';

import type { SessionNavigatorDensity, SessionNavigatorSession } from './types';
import { SessionStateGlyph } from './SessionStateGlyph';

const ROW_MIN_HEIGHT: Record<SessionNavigatorDensity, number> = {
  desktop: 36,
  touch: 44,
};

export type SessionNavigatorItemProps = {
  session: SessionNavigatorSession;
  selected: boolean;
  onSelect: (id: string) => void;
  density?: SessionNavigatorDensity;
};

function stateLabel(state: SessionNavigatorSession['state']): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export function SessionNavigatorItem({
  session,
  selected,
  onSelect,
  density = 'desktop',
}: SessionNavigatorItemProps) {
  const style: CSSProperties = { minHeight: `${ROW_MIN_HEIGHT[density]}px` };

  const handleClick = useCallback(() => {
    onSelect(session.id);
  }, [onSelect, session.id]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault();
      onSelect(session.id);
    },
    [onSelect, session.id],
  );

  return (
    <li
      role="option"
      aria-selected={selected}
      data-selected={selected}
      data-session-id={session.id}
      tabIndex={selected ? 0 : -1}
      style={style}
      className="ccsm-session-navigator__item"
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <SessionStateGlyph state={session.state} label={stateLabel(session.state)} />
      <span className="ccsm-session-navigator__session-copy">
        <span className="ccsm-session-navigator__session-name" title={session.name}>
          {session.name}
        </span>
        <span className="ccsm-session-navigator__session-cwd" title={session.cwd}>
          {session.cwd}
        </span>
      </span>
    </li>
  );
}
