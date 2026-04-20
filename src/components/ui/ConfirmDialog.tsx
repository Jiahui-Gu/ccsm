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
  onConfirm
}: ConfirmDialogProps) {
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    // Delay focus so dialog entrance animation settles before the ring
    // lands — otherwise the ring looks like it jumps into place mid-anim.
    const t = window.setTimeout(() => cancelRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title={title}
        description={description}
        width="440px"
        hideClose={destructive}
        onInteractOutside={destructive ? (e) => e.preventDefault() : undefined}
        onEscapeKeyDown={destructive ? (e) => e.preventDefault() : undefined}
      >
        <DialogFooter>
          <DialogClose asChild>
            <Button ref={cancelRef} variant="secondary" size="md">
              {cancelLabel}
            </Button>
          </DialogClose>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            size="md"
            onClick={() => {
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
