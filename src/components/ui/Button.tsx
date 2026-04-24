import React, { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';

// Apple-tier button. Each variant layers up to four cues:
//   1. base color / gradient
//   2. 1px border in a darker tone (defines silhouette)
//   3. inset top highlight (fakes glass)
//   4. outer shadow (grounds the button)
// Hover shifts brighter; active flips it (pushed-in). Focus-visible adds an
// OUTER halo ring (the only place rings are used).
//
// `has-[>svg]:px-*` shrinks the horizontal padding when the only child is an
// icon, so a leading icon doesn't look stranded against text padding.
export const buttonVariants = cva(
  cn(
    'inline-flex items-center justify-center rounded-md select-none whitespace-nowrap',
    'transition-[background-color,background-image,border-color,color,box-shadow,filter] duration-150',
    '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
    'outline-none disabled:cursor-not-allowed',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5"
  ),
  {
    variants: {
      variant: {
        primary: cn(
          'text-accent-fg font-medium',
          'border border-[oklch(0.55_0.14_215)]',
          'bg-[linear-gradient(to_bottom,oklch(0.82_0.14_215),oklch(0.62_0.14_215))]',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.28),0_1px_0_0_oklch(0_0_0_/_0.18)]',
          'hover:bg-[linear-gradient(to_bottom,oklch(0.86_0.14_215),oklch(0.66_0.14_215))]',
          'active:bg-[linear-gradient(to_bottom,oklch(0.62_0.14_215),oklch(0.70_0.14_215))]',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.28),0_1px_0_0_oklch(0_0_0_/_0.18),0_0_0_3px_oklch(0.72_0.14_215_/_0.35)]',
          'disabled:bg-bg-elevated disabled:bg-none disabled:shadow-none disabled:border-border-default disabled:text-fg-disabled'
        ),
        secondary: cn(
          'bg-bg-elevated text-fg-secondary border border-border-default',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.06)]',
          'hover:bg-bg-hover hover:text-fg-primary hover:border-border-strong',
          'active:bg-bg-active',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.06),0_0_0_3px_oklch(1_0_0_/_0.08)]',
          'disabled:text-fg-disabled disabled:hover:bg-bg-elevated disabled:hover:border-border-default disabled:hover:text-fg-disabled'
        ),
        ghost: cn(
          'bg-transparent text-fg-secondary border border-transparent',
          'hover:bg-bg-hover hover:text-fg-primary',
          'active:bg-bg-active',
          'focus-visible:bg-bg-hover focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.06)]',
          'disabled:text-fg-disabled disabled:hover:bg-transparent disabled:hover:text-fg-disabled'
        ),
        // Sits on top of the sidebar (oklch 0.225). Bg ~0.175 brighter, border
        // brighter still — readable as a "tile" against frosted-glass without
        // hand-rolling OKLCH at the call site.
        raised: cn(
          'text-fg-primary border',
          'bg-[oklch(0.40_0.003_240)] border-[oklch(0.50_0.003_240)]',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.12),0_1px_2px_0_oklch(0_0_0_/_0.4),0_2px_6px_0_oklch(0_0_0_/_0.25)]',
          'hover:bg-[oklch(0.45_0.003_240)] hover:border-[oklch(0.55_0.003_240)] hover:text-fg-primary',
          'active:bg-[oklch(0.36_0.003_240)]',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.12),0_1px_2px_0_oklch(0_0_0_/_0.4),0_2px_6px_0_oklch(0_0_0_/_0.25),0_0_0_2px_oklch(1_0_0_/_0.10)]',
          'disabled:bg-bg-elevated disabled:border-border-default disabled:text-fg-disabled disabled:shadow-none'
        ),
        danger: cn(
          'text-state-error-fg font-medium',
          'border border-[oklch(0.50_0.20_25)]',
          'bg-[linear-gradient(to_bottom,oklch(0.68_0.22_25),oklch(0.56_0.22_25))]',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.22),0_1px_0_0_oklch(0_0_0_/_0.18)]',
          'hover:bg-[linear-gradient(to_bottom,oklch(0.72_0.22_25),oklch(0.60_0.22_25))]',
          'active:bg-[linear-gradient(to_bottom,oklch(0.56_0.22_25),oklch(0.62_0.22_25))]',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.22),0_1px_0_0_oklch(0_0_0_/_0.18),0_0_0_3px_oklch(0.65_0.20_25_/_0.35)]',
          'disabled:bg-bg-elevated disabled:bg-none disabled:shadow-none disabled:border-border-default disabled:text-fg-disabled'
        )
      },
      size: {
        xs: 'h-6 px-2 text-xs gap-1.5 has-[>svg]:px-1.5',
        sm: 'h-6 px-2.5 text-xs gap-1.5 has-[>svg]:px-2',
        md: 'h-7 px-3 text-sm gap-2 has-[>svg]:px-2.5',
        lg: 'h-8 px-4 text-md gap-2 has-[>svg]:px-3'
      }
    },
    defaultVariants: { variant: 'secondary', size: 'md' }
  }
);

export type ButtonVariant = NonNullable<VariantProps<typeof buttonVariants>['variant']>;
export type ButtonSize = NonNullable<VariantProps<typeof buttonVariants>['size']>;

const tapScale: Record<ButtonVariant, number> = {
  primary: 0.98,
  secondary: 0.98,
  ghost: 0.97,
  raised: 0.98,
  danger: 0.98
};

type ButtonProps = Omit<HTMLMotionProps<'button'>, 'children'> &
  VariantProps<typeof buttonVariants> & { children?: React.ReactNode };

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', className, children, disabled, type = 'button', ...rest },
  ref
) {
  return (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: tapScale[variant ?? 'secondary'] }}
      transition={{ type: 'spring', stiffness: 500, damping: 24, mass: 0.5 }}
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    >
      {children}
    </motion.button>
  );
});
