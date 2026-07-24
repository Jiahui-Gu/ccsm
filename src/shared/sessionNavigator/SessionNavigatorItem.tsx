import { useCallback } from 'react';
import type { CSSProperties, KeyboardEvent, MouseEvent } from 'react';

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

export function stateLabel(state: SessionNavigatorSession['state']): string {
  return state.charAt(0).toUpperCase() + state.slice(1);
}

export type SessionNavigatorItemBodyProps = {
  session: SessionNavigatorSession;
  /**
   * Optional handler wired onto the session name span. Lets a platform host
   * (e.g. the desktop SessionRow) trigger inline rename on double-click
   * without the shared body owning any rename state itself.
   */
  onNameDoubleClick?: (event: MouseEvent<HTMLSpanElement>) => void;
};

/**
 * Renders the state glyph + name/cwd copy shared by the desktop and touch
 * session navigators. Intentionally has no outer list-item element so host
 * components (SessionNavigatorItem below, or a platform-specific row) can
 * own their own wrapper, event handlers, and refs.
 */
export function SessionNavigatorItemBody({ session, onNameDoubleClick }: SessionNavigatorItemBodyProps) {
  return (
    <>
      <SessionStateGlyph state={session.state} label={stateLabel(session.state)} />
      <span className="ccsm-session-navigator__session-copy">
        <span
          className="ccsm-session-navigator__session-name"
          title={session.name}
          onDoubleClick={onNameDoubleClick}
        >
          {session.name}
        </span>
        <span className="ccsm-session-navigator__session-cwd" title={session.cwd}>
          {session.cwd}
        </span>
      </span>
    </>
  );
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
      <SessionNavigatorItemBody session={session} />
    </li>
  );
}
