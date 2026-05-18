import React, { useEffect, useId, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogBody, DialogFooter } from './ui/Dialog';
import { Button } from './ui/Button';

/**
 * In-app replacement (#1253) for the previous native
 * `dialog.showMessageBox` shown the first time the user clicks the
 * window X with their close-pref still on 'ask'. Three buttons +
 * "Don't ask again" checkbox, exactly mirroring the old semantics.
 *
 * Strings arrive in `labels` from main (translated via `tCloseDialog`)
 * rather than from the renderer i18n catalog, to avoid duplicating
 * close-dialog copy in two locales and keep main as the single source
 * of truth for OS-language-sensitive surfaces.
 *
 * Choice contract (locked, see `decideCloseAction`):
 *   - 'tray'   → hide window; persist 'tray' iff dontAskAgain.
 *   - 'quit'   → app.quit;    persist 'quit' iff dontAskAgain.
 *   - 'cancel' → no-op;       NEVER persists, even when dontAskAgain
 *                is checked. Cancelling must never trap the user.
 *
 * Every dismiss path (Esc, outside click, X button) is treated as
 * 'cancel'. We must always answer main with SOME choice so main can
 * clear its pending-ask state and the user's next click on the X
 * isn't silently swallowed by the in-flight gate.
 */
export type CloseDialogChoice = 'tray' | 'quit' | 'cancel';

export interface CloseActionLabels {
  message: string;
  detail: string;
  tray: string;
  quit: string;
  cancel: string;
  dontAskAgain: string;
}

export interface CloseActionDialogProps {
  open: boolean;
  /** Caller-driven; we call onResolve THEN onOpenChange(false). */
  onOpenChange: (next: boolean) => void;
  labels: CloseActionLabels | null;
  /**
   * Fires exactly once per open with the user's choice. The caller is
   * responsible for forwarding the choice to main via
   * `window.ccsm.window.resolveCloseAction`.
   */
  onResolve: (result: { choice: CloseDialogChoice; dontAskAgain: boolean }) => void;
}

export function CloseActionDialog({
  open,
  onOpenChange,
  labels,
  onResolve,
}: CloseActionDialogProps) {
  const [dontAskAgain, setDontAskAgain] = useState(false);
  const checkboxId = useId();
  // Default focus lands on the safer "Minimize to tray" button — quitting
  // is the destructive option, and Enter on a freshly-shown dialog
  // shouldn't kill the app.
  const trayRef = useRef<HTMLButtonElement>(null);
  // Distinguish a "user picked something" close from an Esc/X/outside
  // close so we only fire onResolve once per open.
  const resolvedRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    resolvedRef.current = false;
    setDontAskAgain(false);
    // Delay focus so the dialog entrance animation lands before the focus
    // ring snaps in — matches ConfirmDialog's timing.
    const t = window.setTimeout(() => trayRef.current?.focus(), 150);
    return () => window.clearTimeout(t);
  }, [open]);

  const pick = (choice: CloseDialogChoice) => {
    if (resolvedRef.current) return;
    resolvedRef.current = true;
    // 'cancel' never persists, even when the checkbox is on. Surface the
    // raw user input here; the main-side decider enforces the policy.
    onResolve({ choice, dontAskAgain });
    onOpenChange(false);
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !resolvedRef.current) {
          // Esc / X / outside click — treat as Cancel so main clears its
          // pending-ask gate and the user can click X again.
          resolvedRef.current = true;
          onResolve({ choice: 'cancel', dontAskAgain });
        }
        onOpenChange(next);
      }}
    >
      <DialogContent
        title={labels?.message ?? ''}
        description={labels?.detail ?? ''}
        width="460px"
        data-testid="close-action-dialog"
      >
        <DialogBody>
          <label
            className="flex items-center gap-2 text-chrome text-fg-secondary select-none cursor-pointer"
            htmlFor={checkboxId}
          >
            <input
              id={checkboxId}
              type="checkbox"
              className="size-3.5 accent-[var(--color-accent)] cursor-pointer"
              checked={dontAskAgain}
              onChange={(e) => setDontAskAgain(e.target.checked)}
              data-testid="close-action-dontask"
            />
            <span>{labels?.dontAskAgain ?? ''}</span>
          </label>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="ghost"
            size="md"
            onClick={() => pick('cancel')}
            data-testid="close-action-cancel"
          >
            {labels?.cancel ?? ''}
          </Button>
          <Button
            variant="danger"
            size="md"
            onClick={() => pick('quit')}
            data-testid="close-action-quit"
          >
            {labels?.quit ?? ''}
          </Button>
          <Button
            ref={trayRef}
            variant="primary"
            size="md"
            onClick={() => pick('tray')}
            data-testid="close-action-tray"
          >
            {labels?.tray ?? ''}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
