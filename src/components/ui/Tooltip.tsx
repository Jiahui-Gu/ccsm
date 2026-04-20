import React, { forwardRef } from 'react';
import * as RT from '@radix-ui/react-tooltip';
import { cn } from '../../lib/cn';

export const TooltipProvider = RT.Provider;

type TooltipProps = {
  content: React.ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  align?: 'start' | 'center' | 'end';
  openDelay?: number;
  closeDelay?: number;
  children: React.ReactNode;
};

// Fallback provider so callers don't have to wrap individually.
export function Tooltip({
  content,
  side = 'top',
  align = 'center',
  openDelay = 400,
  closeDelay = 100,
  children
}: TooltipProps) {
  return (
    <RT.Provider delayDuration={openDelay} skipDelayDuration={closeDelay}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            side={side}
            align={align}
            sideOffset={6}
            className={cn(
              'z-50 px-2 py-1 rounded-md border',
              'border-border-default bg-bg-elevated text-fg-secondary',
              'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.04),0_2px_8px_oklch(0_0_0_/_0.35)]',
              'text-xs select-none pointer-events-none',
              'data-[state=delayed-open]:animate-[tooltipIn_140ms_cubic-bezier(0.32,0.72,0,1)]',
              'data-[state=closed]:opacity-0'
            )}
          >
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}

// Re-export raw primitives for advanced cases.
export const TooltipRoot = RT.Root;
export const TooltipTrigger = RT.Trigger;
export const TooltipContent = forwardRef<
  React.ElementRef<typeof RT.Content>,
  React.ComponentPropsWithoutRef<typeof RT.Content>
>(function TooltipContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <RT.Content
      ref={ref}
      sideOffset={sideOffset}
      className={cn(
        'z-50 px-2 py-1 rounded-md border border-border-default bg-bg-elevated',
        'surface-highlight surface-elevated',
        'shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.04),0_2px_8px_oklch(0_0_0_/_0.35)]',
        'text-fg-secondary text-xs select-none pointer-events-none',
        'data-[state=delayed-open]:animate-[tooltipIn_140ms_cubic-bezier(0.32,0.72,0,1)]',
        'data-[state=closed]:opacity-0',
        className
      )}
      {...rest}
    />
  );
});
