import { clsx, type ClassValue } from 'clsx';
import { extendTailwindMerge } from 'tailwind-merge';

// Teach tailwind-merge about the 4-step semantic font-size tokens added in
// #225 (text-meta / text-chrome / text-body / text-heading) plus the
// pre-existing mono micro-scale (text-mono-xs/sm/md/lg).
//
// Without this, twMerge classifies anything matching `text-<x>` where <x> is
// a non-numeric word as a font-color utility — and `cn('text-chrome', 'text-fg-primary')`
// would collapse to just `text-fg-primary`, silently nuking the font-size
// rename. The Sidebar selected-row regression we hit in harness-ui's
// type-scale-snapshot case was exactly this: `text-chrome` was being dropped
// from the selected `<li>` because `text-fg-primary` followed it.
//
// We register the new names under `font-size` so they correctly conflict with
// each other (and with text-xs/sm/base/etc.) but NOT with text-fg-* color
// utilities.
const merge = extendTailwindMerge({
  extend: {
    classGroups: {
      'font-size': [
        { text: ['meta', 'chrome', 'body', 'heading', 'display', 'mono-xs', 'mono-sm', 'mono-md', 'mono-lg'] }
      ]
    }
  }
});

export function cn(...inputs: ClassValue[]) {
  return merge(clsx(inputs));
}
