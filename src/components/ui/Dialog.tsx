import React, { forwardRef } from 'react';
import * as RD from '@radix-ui/react-dialog';
import { X } from 'lucide-react';
import { cn } from '../../lib/cn';
import { IconButton } from './IconButton';
import { useTranslation } from '../../i18n/useTranslation';

export const Dialog = RD.Root;
export const DialogTrigger = RD.Trigger;
export const DialogClose = RD.Close;
export const DialogPortal = RD.Portal;

export const DialogOverlay = forwardRef<
  React.ElementRef<typeof RD.Overlay>,
  React.ComponentPropsWithoutRef<typeof RD.Overlay>
>(function DialogOverlay({ className, ...rest }, ref) {
  return (
    <RD.Overlay
      ref={ref}
      className={cn(
        'fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]',
        'data-[state=open]:animate-[overlayIn_160ms_cubic-bezier(0.32,0.72,0,1)]',
        'data-[state=closed]:opacity-0',
        // When Radix nests dialogs (or leaves an overlay mounted with
        // aria-hidden=true behind a higher modal), the overlay still
        // intercepts pointer events and breaks click-through to the
        // underlying UI -- surfaces as e2e flakes ("intercepts pointer
        // events" on `<div data-state="open" aria-hidden="true" ...
        // backdrop-blur ...>`). Radix mirrors aria-hidden as
        // data-aria-hidden so we can target it via Tailwind's
        // data-[...] variant (the [&[aria-hidden="true"]] arbitrary-
        // selector form does not survive Tailwind v4 JIT through quoted
        // attribute values reliably).
        'data-[aria-hidden=true]:pointer-events-none',
        className
      )}
      {...rest}
    />
  );
});

type DialogContentProps = React.ComponentPropsWithoutRef<typeof RD.Content> & {
  title?: React.ReactNode;
  description?: React.ReactNode;
  hideClose?: boolean;
  width?: string;
};

export const DialogContent = forwardRef<
  React.ElementRef<typeof RD.Content>,
  DialogContentProps
>(function DialogContent(
  { className, children, title, description, hideClose, width = '520px', ...rest },
  ref
) {
  const { t } = useTranslation('common');
  return (
    <DialogPortal>
      <DialogOverlay />
      <RD.Content
        ref={ref}
        // Marker used by InputBar's global Esc handler to back off. Inline
        // sticky widgets (AskUserQuestion, CwdPopover) also use role="dialog"
        // for a11y but are NOT modal — they should not consume Esc-to-stop.
        data-modal-dialog=""
        aria-modal="true"
        className={cn(
          'fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2',
          'rounded-lg border border-border-default bg-bg-panel',
          'surface-highlight',
          'shadow-[var(--surface-shadow)]',
          'text-fg-primary outline-none',
          'data-[state=open]:animate-[dialogIn_200ms_cubic-bezier(0.32,0.72,0,1)]',
          'data-[state=closed]:opacity-0',
          className
        )}
        style={{ width }}
        {...rest}
      >
        {(title || description || !hideClose) && (
          <div className="flex items-start gap-3 px-5 pt-4 pb-3">
            <div className="flex-1 min-w-0">
              {title && (
                <RD.Title className="text-heading font-semibold text-fg-primary leading-tight">
                  {title}
                </RD.Title>
              )}
              {description && (
                <RD.Description className="mt-1 text-chrome text-fg-tertiary">
                  {description}
                </RD.Description>
              )}
            </div>
            {!hideClose && (
              <DialogClose asChild>
                <IconButton size="sm" aria-label={t('close')}>
                  <X size={13} className="stroke-[1.75]" />
                </IconButton>
              </DialogClose>
            )}
          </div>
        )}
        {children}
      </RD.Content>
    </DialogPortal>
  );
});

export function DialogBody({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={cn('px-5 pb-3', className)}>{children}</div>;
}

export function DialogFooter({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        'flex items-center justify-end gap-2 px-5 py-3 border-t border-border-subtle',
        className
      )}
    >
      {children}
    </div>
  );
}
