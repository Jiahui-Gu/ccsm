import React, { forwardRef } from 'react';
import * as RDM from '@radix-ui/react-dropdown-menu';
import { cn } from '../../lib/cn';

export const DropdownMenu = RDM.Root;
export const DropdownMenuTrigger = RDM.Trigger;
export const DropdownMenuPortal = RDM.Portal;
export const DropdownMenuGroup = RDM.Group;
export const DropdownMenuSub = RDM.Sub;
export const DropdownMenuSubTrigger = RDM.SubTrigger;
export const DropdownMenuSubContent = RDM.SubContent;

export const DropdownMenuLabel = forwardRef<
  React.ElementRef<typeof RDM.Label>,
  React.ComponentPropsWithoutRef<typeof RDM.Label>
>(function DropdownMenuLabel({ className, ...rest }, ref) {
  return (
    <RDM.Label
      ref={ref}
      className={cn(
        'px-3 pt-1.5 pb-1 text-mono-sm font-medium text-fg-tertiary',
        className
      )}
      {...rest}
    />
  );
});

export const DropdownMenuContent = forwardRef<
  React.ElementRef<typeof RDM.Content>,
  React.ComponentPropsWithoutRef<typeof RDM.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...rest }, ref) {
  return (
    <RDM.Portal>
      <RDM.Content
        ref={ref}
        sideOffset={sideOffset}
        className={cn(
          'z-50 min-w-[180px] py-1 rounded-md border border-border-default bg-bg-elevated',
          'surface-highlight surface-elevated',
          'text-sm text-fg-secondary outline-none',
          'data-[state=open]:animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]',
          'data-[state=closed]:opacity-0',
          'origin-[var(--radix-dropdown-menu-content-transform-origin)]',
          className
        )}
        {...rest}
      />
    </RDM.Portal>
  );
});

export const DropdownMenuItem = forwardRef<
  React.ElementRef<typeof RDM.Item>,
  React.ComponentPropsWithoutRef<typeof RDM.Item> & { danger?: boolean }
>(function DropdownMenuItem({ className, danger, ...rest }, ref) {
  return (
    <RDM.Item
      ref={ref}
      className={cn(
        'relative flex items-center h-7 px-3 mx-1 rounded-sm cursor-pointer select-none',
        'outline-none transition-[background-color,color,box-shadow] duration-150',
        '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
        danger
          ? 'text-state-error data-[highlighted]:bg-state-error/15 data-[highlighted]:text-state-error'
          : 'data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg-primary data-[highlighted]:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)] active:bg-bg-active',
        'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
        className
      )}
      {...rest}
    />
  );
});

export const DropdownMenuSeparator = forwardRef<
  React.ElementRef<typeof RDM.Separator>,
  React.ComponentPropsWithoutRef<typeof RDM.Separator>
>(function DropdownMenuSeparator({ className, ...rest }, ref) {
  return (
    <RDM.Separator
      ref={ref}
      className={cn('my-1 h-px bg-border-subtle', className)}
      {...rest}
    />
  );
});
