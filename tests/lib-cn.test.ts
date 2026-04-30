// UT for src/lib/cn.ts — the project-wide className merger built on top of
// `clsx` + `tailwind-merge`, with the additional `font-size` class group
// registration that teaches `tailwind-merge` about the 4-step semantic
// font-size tokens (text-meta / text-chrome / text-body / text-heading,
// plus the mono-* scale).
//
// The original Sidebar regression that motivated extendTailwindMerge was
// that `cn('text-chrome', 'text-fg-primary')` collapsed to just
// `text-fg-primary` — silently dropping the font-size token because
// tailwind-merge classified `text-chrome` as a font-color utility. The
// tests below pin both the happy path (color + font-size keep both, two
// font-sizes collapse to the later one) and the basic clsx pass-through.
import { describe, it, expect } from 'vitest';
import { cn } from '../src/lib/cn';

describe('cn()', () => {
  it('passes through a single class unchanged', () => {
    expect(cn('text-fg-primary')).toBe('text-fg-primary');
  });

  it('joins multiple distinct classes with spaces (clsx pass-through)', () => {
    const out = cn('flex', 'items-center', 'gap-2');
    expect(out.split(/\s+/).sort()).toEqual(['flex', 'gap-2', 'items-center']);
  });

  it('honors clsx conditional forms (objects + falsy)', () => {
    expect(
      cn('a', { b: true, c: false }, undefined, null, ['d', false && 'e'])
    ).toBe('a b d');
  });

  it('keeps font-size token AND color token together (regression for #225)', () => {
    // Without the extendTailwindMerge font-size class group, twMerge would
    // treat `text-chrome` as a color utility and drop it when followed by
    // `text-fg-primary`. The whole point of the extension is that both
    // survive: the size token AND the color token coexist.
    const out = cn('text-chrome', 'text-fg-primary');
    expect(out).toContain('text-chrome');
    expect(out).toContain('text-fg-primary');
  });

  it.each([
    ['text-meta', 'text-chrome'],
    ['text-chrome', 'text-body'],
    ['text-body', 'text-heading'],
    ['text-heading', 'text-display'],
    ['text-mono-xs', 'text-mono-lg'],
  ])('collapses two font-size tokens %s + %s → only the later survives', (first, later) => {
    const out = cn(first, later);
    // Only the later token wins (twMerge's standard behavior for same group).
    expect(out).toBe(later);
  });

  it('still collapses standard tailwind size utilities (text-xs vs text-base)', () => {
    expect(cn('text-xs', 'text-base')).toBe('text-base');
  });

  it('mixing semantic font-size with standard tailwind size collapses to the later one', () => {
    // Both are now in the same `font-size` group, so twMerge sees them as
    // conflicting and the later wins.
    expect(cn('text-chrome', 'text-base')).toBe('text-base');
    expect(cn('text-base', 'text-heading')).toBe('text-heading');
  });
});
