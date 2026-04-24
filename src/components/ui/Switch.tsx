import React from 'react';
import * as RadixSwitch from '@radix-ui/react-switch';
import { cn } from '../../lib/cn';

/**
 * Track + thumb toggle primitive (#288). Built on Radix `react-switch` so
 * keyboard semantics (Space / Enter), `aria-checked`, focus management, and
 * controlled-vs-uncontrolled behavior are handled by the library — we only
 * own the visual layer.
 *
 * Why this exists:
 * Settings used a hand-rolled `<input type="checkbox">` styled with
 * `accent-accent` for five notification toggles + the auto-update toggle.
 * Native checkboxes don't read as "switch" semantically (a screen reader
 * announces "checkbox" instead of "switch"), can't be styled consistently
 * across Win/macOS/Linux Electron renderers, and don't have an obvious
 * on/off affordance. A real switch primitive fixes all three.
 *
 * Visual contract:
 *   - Track: 28×16 (h-4 w-7), rounded-full. Off → bg-border-strong; on →
 *     bg-accent.
 *   - Thumb: 12×12 (h-3 w-3) circle, white in dark theme, white in light
 *     too (the track tint is what distinguishes states). Translates 12px
 *     when checked.
 *   - Hover: subtle brightness bump on the track.
 *   - Focus: shared `.focus-ring` (3px outset accent halo at 0.30 alpha).
 *   - Disabled: opacity 0.55 + `cursor-not-allowed`. Pointer events still
 *     reach Radix so screen readers announce the disabled state correctly.
 *
 * Accessibility:
 *   - `role="switch"` + `aria-checked` are wired by Radix.
 *   - Pass `aria-label` (or have an associated `<label htmlFor>` upstream)
 *     so the toggle has an accessible name. Settings.tsx call sites pass
 *     `aria-label` carried over from their previous `<input type="checkbox">`.
 */
export interface SwitchProps
  extends Omit<RadixSwitch.SwitchProps, 'asChild'> {
  /** Optional extra class on the track. Rare; styling lives here. */
  className?: string;
}

export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  function Switch({ className, disabled, ...rest }, ref) {
    return (
      <RadixSwitch.Root
        ref={ref}
        disabled={disabled}
        className={cn(
          // Track
          'relative inline-flex h-4 w-7 shrink-0 items-center rounded-full',
          'bg-border-strong data-[state=checked]:bg-accent',
          'transition-colors duration-150',
          // Hover (only when interactive)
          !disabled &&
            'hover:bg-[color-mix(in_oklch,var(--color-border-strong),white_8%)] data-[state=checked]:hover:bg-[color-mix(in_oklch,var(--color-accent),white_8%)]',
          // Focus halo (project-standard)
          'focus-ring outline-none',
          // Disabled
          disabled && 'opacity-55 cursor-not-allowed',
          className
        )}
        {...rest}
      >
        <RadixSwitch.Thumb
          className={cn(
            'block h-3 w-3 rounded-full bg-white shadow-sm',
            'translate-x-0.5 data-[state=checked]:translate-x-[14px]',
            'transition-transform duration-150 ease-out'
          )}
        />
      </RadixSwitch.Root>
    );
  }
);
