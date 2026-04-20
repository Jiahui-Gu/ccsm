import React, { forwardRef } from 'react';
import { motion, type HTMLMotionProps } from 'framer-motion';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../../lib/cn';
import { Tooltip } from './Tooltip';

// Square ghost button. On hover the bg "lifts" via an inset top highlight,
// so it reads as a pressable surface rather than a flat color swap.
export const iconButtonVariants = cva(
  cn(
    'inline-grid place-items-center rounded-md select-none outline-none',
    'border border-transparent',
    'transition-[background-color,border-color,color,box-shadow] duration-150',
    '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
    'disabled:cursor-not-allowed',
    "[&_svg]:pointer-events-none [&_svg]:shrink-0"
  ),
  {
    variants: {
      variant: {
        ghost: cn(
          'text-fg-tertiary',
          'hover:bg-bg-hover hover:text-fg-primary',
          'hover:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]',
          'active:bg-bg-active',
          'focus-visible:bg-bg-hover focus-visible:shadow-[0_0_0_2px_oklch(1_0_0_/_0.06)]',
          'disabled:text-fg-disabled disabled:hover:bg-transparent disabled:hover:text-fg-disabled disabled:hover:shadow-none disabled:hover:border-transparent'
        ),
        outlined: cn(
          'text-fg-tertiary bg-bg-elevated border-border-default',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.06)]',
          'hover:bg-bg-hover hover:text-fg-primary hover:border-border-strong',
          'active:bg-bg-active',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.06),0_0_0_3px_oklch(1_0_0_/_0.08)]',
          'disabled:text-fg-disabled'
        ),
        // Pair with Button `raised` for matched square actions on the sidebar.
        raised: cn(
          'text-fg-secondary',
          'bg-[oklch(0.40_0.003_240)] border-[oklch(0.50_0.003_240)]',
          'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.12),0_1px_2px_0_oklch(0_0_0_/_0.4),0_2px_6px_0_oklch(0_0_0_/_0.25)]',
          'hover:bg-[oklch(0.45_0.003_240)] hover:border-[oklch(0.55_0.003_240)] hover:text-fg-primary',
          'active:bg-[oklch(0.36_0.003_240)]',
          'focus-visible:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.12),0_1px_2px_0_oklch(0_0_0_/_0.4),0_2px_6px_0_oklch(0_0_0_/_0.25),0_0_0_2px_oklch(1_0_0_/_0.10)]',
          'disabled:text-fg-disabled'
        )
      },
      size: {
        xs: 'h-6 w-6',
        sm: 'h-7 w-7',
        md: 'h-8 w-8'
      }
    },
    defaultVariants: { variant: 'ghost', size: 'sm' }
  }
);

export type IconButtonSize = NonNullable<VariantProps<typeof iconButtonVariants>['size']>;
export type IconButtonVariant = NonNullable<VariantProps<typeof iconButtonVariants>['variant']>;

type IconButtonProps = Omit<HTMLMotionProps<'button'>, 'children'> &
  VariantProps<typeof iconButtonVariants> & {
    tooltip?: React.ReactNode;
    tooltipSide?: 'top' | 'right' | 'bottom' | 'left';
    children: React.ReactNode;
  };

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  {
    size = 'sm',
    variant = 'ghost',
    tooltip,
    tooltipSide = 'top',
    className,
    children,
    disabled,
    type = 'button',
    ...rest
  },
  ref
) {
  const node = (
    <motion.button
      ref={ref}
      type={type}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.94 }}
      transition={{ type: 'spring', stiffness: 700, damping: 32, mass: 0.4 }}
      data-variant={variant}
      data-size={size}
      className={cn(iconButtonVariants({ variant, size }), className)}
      {...rest}
    >
      {children}
    </motion.button>
  );
  if (!tooltip) return node;
  return (
    <Tooltip content={tooltip} side={tooltipSide}>
      {node}
    </Tooltip>
  );
});
