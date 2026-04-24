import React, { forwardRef } from 'react';
import * as RCM from '@radix-ui/react-context-menu';
import { ChevronRight } from 'lucide-react';
import { cn } from '../../lib/cn';

export const ContextMenu = RCM.Root;
export const ContextMenuTrigger = RCM.Trigger;
export const ContextMenuPortal = RCM.Portal;
export const ContextMenuGroup = RCM.Group;
export const ContextMenuLabel = RCM.Label;
export const ContextMenuSub = RCM.Sub;

export const ContextMenuContent = forwardRef<
  React.ElementRef<typeof RCM.Content>,
  React.ComponentPropsWithoutRef<typeof RCM.Content>
>(function ContextMenuContent({ className, ...rest }, ref) {
  return (
    <RCM.Portal>
      <RCM.Content
        ref={ref}
        className={cn(
          'z-50 min-w-[180px] py-1 rounded-md border border-border-default bg-bg-elevated',
          'surface-highlight surface-elevated',
          'text-chrome text-fg-secondary outline-none',
          'data-[state=open]:animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]',
          'origin-[var(--radix-context-menu-content-transform-origin)]',
          className
        )}
        {...rest}
      />
    </RCM.Portal>
  );
});

export const ContextMenuItem = forwardRef<
  React.ElementRef<typeof RCM.Item>,
  React.ComponentPropsWithoutRef<typeof RCM.Item> & { danger?: boolean }
>(function ContextMenuItem({ className, danger, ...rest }, ref) {
  return (
    <RCM.Item
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

export const ContextMenuSubTrigger = forwardRef<
  React.ElementRef<typeof RCM.SubTrigger>,
  React.ComponentPropsWithoutRef<typeof RCM.SubTrigger>
>(function ContextMenuSubTrigger({ className, children, ...rest }, ref) {
  return (
    <RCM.SubTrigger
      ref={ref}
      className={cn(
        'relative flex items-center justify-between gap-2 h-7 px-3 mx-1 rounded-sm cursor-pointer select-none',
        'outline-none transition-[background-color,color,box-shadow] duration-150',
        '[transition-timing-function:cubic-bezier(0.32,0.72,0,1)]',
        'data-[highlighted]:bg-bg-hover data-[highlighted]:text-fg-primary data-[highlighted]:shadow-[inset_0_1px_0_0_oklch(1_0_0_/_0.05)]',
        'data-[state=open]:bg-bg-hover data-[state=open]:text-fg-primary',
        'data-[disabled]:opacity-40 data-[disabled]:cursor-not-allowed',
        className
      )}
      {...rest}
    >
      {children}
      <ChevronRight size={12} className="text-fg-tertiary shrink-0" />
    </RCM.SubTrigger>
  );
});

export const ContextMenuSubContent = forwardRef<
  React.ElementRef<typeof RCM.SubContent>,
  React.ComponentPropsWithoutRef<typeof RCM.SubContent>
>(function ContextMenuSubContent({ className, ...rest }, ref) {
  return (
    <RCM.Portal>
      <RCM.SubContent
        ref={ref}
        className={cn(
          'z-50 min-w-[180px] py-1 rounded-md border border-border-default bg-bg-elevated',
          'surface-highlight surface-elevated',
          'text-chrome text-fg-secondary outline-none',
          'data-[state=open]:animate-[menuIn_140ms_cubic-bezier(0.32,0.72,0,1)]',
          'origin-[var(--radix-context-menu-content-transform-origin)]',
          className
        )}
        {...rest}
      />
    </RCM.Portal>
  );
});

export const ContextMenuSeparator = forwardRef<
  React.ElementRef<typeof RCM.Separator>,
  React.ComponentPropsWithoutRef<typeof RCM.Separator>
>(function ContextMenuSeparator({ className, ...rest }, ref) {
  return (
    <RCM.Separator
      ref={ref}
      className={cn('my-1 h-px bg-border-subtle', className)}
      {...rest}
    />
  );
});
