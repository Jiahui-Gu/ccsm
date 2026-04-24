import type { HTMLAttributes, ReactNode } from 'react';
import { cn } from '../../lib/cn';

// MetaLabel — column header / micro-label primitive (#285).
//
// Before this primitive, ~10 sites across popovers, the slash-command picker,
// and tutorial chrome rolled their own
//   `font-mono text-mono-xs uppercase tracking-wider text-fg-tertiary`
// (and a couple of mono-sm variants). Each callsite drifted slightly —
// some omitted `font-mono`, one used `text-meta` instead of `text-mono-xs`,
// and a few injected extra padding inline. Centralizing the recipe here:
//   - guarantees identical typography across popover-style surfaces
//   - keeps `select-none` baked in (these are decorative chrome, never
//     meant to be selectable)
//   - exposes a `size` prop for the two natural sizes we have in the
//     codebase: `xs` (10/14, the default — used for picker section headers
//     and inline counters) and `sm` (11/15 — used for the cwd popover's
//     "Recent" header where the larger leading reads better above a list
//     row).
//
// Naming note (#300): MetaLabel rides the **mono** micro-scale
// (`text-mono-xs` = 10/14, `text-mono-sm` = 11/15). It is NOT interchangeable
// with the proportional `text-meta` (11px Inter) used for banner subtitles
// and toast bodies. See the comment block above the `.text-mono-*` rules in
// `src/styles/global.css` for the full rationale.
//
// We deliberately keep this as a thin wrapper rather than a styled span:
// callers can still pass `className` to add layout (margins, padding,
// alignment) without re-asserting the type recipe.
export type MetaLabelSize = 'xs' | 'sm';

type MetaLabelProps = HTMLAttributes<HTMLSpanElement> & {
  size?: MetaLabelSize;
  children: ReactNode;
};

export function MetaLabel({ size = 'xs', className, children, ...rest }: MetaLabelProps) {
  return (
    <span
      {...rest}
      className={cn(
        'font-mono uppercase tracking-wider text-fg-tertiary select-none',
        size === 'sm' ? 'text-mono-sm' : 'text-mono-xs',
        className
      )}
    >
      {children}
    </span>
  );
}
