import type { ReactNode } from 'react';

import type { SessionNavigatorState } from './types';

const PATHS: Record<SessionNavigatorState, ReactNode> = {
  active: <circle cx="6" cy="6" r="4" fill="currentColor" />,
  idle: <circle cx="6" cy="6" r="3.5" fill="none" stroke="currentColor" strokeWidth="1.25" />,
  waiting: (
    <rect
      x="2.5"
      y="2.5"
      width="7"
      height="7"
      rx="1"
      transform="rotate(45 6 6)"
      fill="currentColor"
    />
  ),
  exited: <path d="M3 3l6 6M9 3L3 9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />,
};

export type SessionStateGlyphProps = {
  state: SessionNavigatorState;
  label: string;
  size?: number;
  /**
   * When true, the glyph is purely decorative and hidden from the
   * accessibility tree (aria-hidden, no role/label). Defaults to false,
   * which keeps the existing role="img" + aria-label behavior used by the
   * shared session navigator list.
   */
  decorative?: boolean;
  /** Extra class name(s) appended to the wrapper's base glyph class. */
  className?: string;
};

export function SessionStateGlyph({
  state,
  label,
  size = 12,
  decorative = false,
  className,
}: SessionStateGlyphProps) {
  const wrapperClassName = className
    ? `ccsm-session-navigator__glyph ${className}`
    : 'ccsm-session-navigator__glyph';
  return (
    <span
      role={decorative ? undefined : 'img'}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? 'true' : undefined}
      title={label}
      data-state={state}
      className={wrapperClassName}
    >
      <svg width={size} height={size} viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        {PATHS[state]}
      </svg>
      {!decorative && <span className="ccsm-session-navigator__sr-only">{label}</span>}
    </span>
  );
}
