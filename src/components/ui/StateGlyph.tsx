import React from 'react';
import { cn } from '../../lib/cn';

type Size = 'xs' | 'sm' | 'md';

const SIZE_PX: Record<Size, number> = { xs: 8, sm: 10, md: 12 };

// Diamond glyph used inline in waiting prompts / toasts as a compact marker.
// Kept as an SVG (not a unicode character) so stroke weight and alignment
// stay crisp across sizes. Only a diamond — the sidebar attention signal is
// the breathing halo on AgentIcon, not a shape; this component is purely
// decorative inside message blocks.
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
  const stroke = Math.max(1, px * 0.14);
  const c = px / 2;

  const a11y = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img' as const, 'aria-label': 'waiting' };

  return (
    <svg
      width={px}
      height={px}
      viewBox={`0 0 ${px} ${px}`}
      className={cn('inline-block shrink-0 text-state-waiting', className)}
      {...a11y}
    >
      <rect
        x={c - (px / 2 - stroke / 2)}
        y={c - (px / 2 - stroke / 2)}
        width={px - stroke}
        height={px - stroke}
        fill="currentColor"
        transform={`rotate(45 ${c} ${c})`}
        rx={stroke / 2}
      />
    </svg>
  );
}
