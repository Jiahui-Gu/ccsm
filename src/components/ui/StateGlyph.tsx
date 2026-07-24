import React from 'react';
import { cn } from '../../lib/cn';
import { SessionStateGlyph } from '../../shared/sessionNavigator/presentation';

type Size = 'xs' | 'sm' | 'md';

const SIZE_PX: Record<Size, number> = { xs: 8, sm: 10, md: 12 };

// Diamond glyph used inline in waiting prompts / toasts as a compact marker.
// Delegates its SVG rendering to the shared session-navigator's
// SessionStateGlyph (src/shared/sessionNavigator) so the desktop sidebar and
// this standalone marker draw the same "waiting" diamond from one source of
// truth (Task 4, mobile-remote-shared-ui plan). Public API (size/className/
// decorative) is unchanged — only the internal rendering moved.
export function StateGlyph({
  size = 'sm',
  className,
  decorative = false,
}: {
  size?: Size;
  className?: string;
  decorative?: boolean;
} & { state?: 'waiting' }) {
  const px = SIZE_PX[size];

  return (
    <SessionStateGlyph
      state="waiting"
      label="waiting"
      size={px}
      decorative={decorative}
      className={cn('text-state-waiting', className)}
    />
  );
}
