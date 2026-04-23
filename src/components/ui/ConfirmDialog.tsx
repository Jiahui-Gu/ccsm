import React, { useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogFooter, DialogClose } from './Dialog';
import { Button } from './Button';

type ConfirmDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
  /**
   * Optional explicit cancel handler. Fires when the user cancels via Esc,
   * clicks the Cancel button, clicks outside, or hits the close (X) button.
   * For non-destructive dialogs this runs alongside the close (onOpenChange
   * still fires). Leave undefined if you only need close behavior.
   */
  onCancel?: () => void;
};

// Focus lands on Cancel by default — an accidental Enter/Space mustn't
// confirm a destructive action. Consumer can override via destructive=false
// + manual focus control if needed.
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Reset the confirm marker each time the dialog opens so a prior
    // confirm doesn't suppress onCancel on the next cancel.
    confirmingRef.current = false;
    // Delay focus so dialog entrance animation settles before the ring
    // lands — otherwise the ring looks like it jumps into place mid-anim.
    const t = window.setTimeout(() => cancelRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, [open]);

  // Track whether the last close was triggered by the Confirm button so we
  // can distinguish it from a cancel path (Esc, Cancel, X, outside click).
  const confirmingRef = useRef(false);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Route every "close without confirming" path through the cancel
        // handler: Esc, clicking the X button, clicking outside (when not
        // destructive), and clicking the Cancel button (DialogClose).
        if (!next && open && !confirmingRef.current) onCancel?.();
        confirmingRef.current = false;
        onOpenChange(next);
      }}
    >
      <DialogContent
        title={title}
        description={description}
        width="440px"
        hideClose={destructive}
        onInteractOutside={destructive ? (e) => e.preventDefault() : undefined}
        // Esc behavior:
        //   - destructive: block Esc so a stray keypress can't silently
        //     trigger a destructive cancel/close path. User must click
        //     Cancel or confirm explicitly. Documented here so future
        //     readers don't "fix" it.
        //   - otherwise: let Esc propagate through Radix's default close,
        //     which flows into onOpenChange above and calls onCancel.
        onEscapeKeyDown={destructive ? (e) => e.preventDefault() : undefined}
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button
              ref={cancelRef}
              variant="secondary"
              size="md"
            >
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="md"
            onClick={() => {
              confirmingRef.current = true;
              onConfirm();
              onOpenChange(false);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
