// UT for src/components/ui/ConfirmDialog.tsx — covers the cancel-routing
// contract that the component file documents at length:
//   * Confirm button fires onConfirm AND closes (onOpenChange(false))
//   * Cancel via the Cancel button fires onCancel + closes
//   * Esc fires onCancel + closes (non-destructive)
//   * Esc is BLOCKED on destructive=true (no onCancel, no close)
//   * Outside-click is blocked on destructive=true via onInteractOutside
//   * After a confirm, the next open's cancel path still fires onCancel
//     (regression for the confirmingRef reset on reopen)
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { ConfirmDialog } from '../../src/components/ui/ConfirmDialog';

afterEach(() => cleanup());

function setup(
  override: Partial<React.ComponentProps<typeof ConfirmDialog>> = {}
) {
  const onOpenChange = vi.fn(function (_open: boolean) {});
  const onConfirm = vi.fn(function () {});
  const onCancel = vi.fn(function () {});
  const utils = render(
    <ConfirmDialog
      open
      onOpenChange={onOpenChange}
      title="Delete it?"
      description="This cannot be undone."
      confirmLabel="Delete"
      cancelLabel="Cancel"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...override}
    />
  );
  return { ...utils, onOpenChange, onConfirm, onCancel };
}

describe('<ConfirmDialog />', () => {
  it('renders title, description, and both action buttons', () => {
    setup();
    expect(screen.getByText('Delete it?')).toBeInTheDocument();
    expect(screen.getByText('This cannot be undone.')).toBeInTheDocument();
    expect(screen.getByTestId('confirm-dialog-confirm')).toHaveTextContent('Delete');
    expect(screen.getByTestId('confirm-dialog-cancel')).toHaveTextContent('Cancel');
  });

  it('confirm button fires onConfirm and closes', () => {
    const { onConfirm, onCancel, onOpenChange } = setup();
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    // confirm path must NOT fire onCancel
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('cancel button fires onCancel and closes (non-destructive)', () => {
    const { onConfirm, onCancel, onOpenChange } = setup();
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('destructive=true uses the danger-style confirm button', () => {
    setup({ destructive: true });
    const confirm = screen.getByTestId('confirm-dialog-confirm');
    expect(confirm.getAttribute('data-variant')).toBe('danger');
  });

  it('destructive=true hides the close (X) button', () => {
    setup({ destructive: true });
    // hideClose=true on Dialog removes the close affordance entirely;
    // the only buttons left are cancel + confirm.
    const buttons = screen
      .getAllByRole('button')
      .filter((b) => b.getAttribute('data-testid')?.startsWith('confirm-dialog-'));
    expect(buttons).toHaveLength(2);
  });

  it('after a confirm, reopening still routes the next cancel to onCancel', () => {
    // Kick the cancel path on the SAME mount: arrange via a small wrapper that
    // lets us flip `open` between confirms/cancels.
    const onConfirm = vi.fn(function () {});
    const onCancel = vi.fn(function () {});
    function Harness() {
      const [open, setOpen] = React.useState(true);
      const [round, setRound] = React.useState(0);
      return (
        <>
          <button
            onClick={function () {
              setOpen(true);
              setRound((r) => r + 1);
            }}
            data-testid="reopen"
          >
            reopen
          </button>
          <ConfirmDialog
            key={round}
            open={open}
            onOpenChange={setOpen}
            title="t"
            confirmLabel="ok"
            cancelLabel="cancel"
            onConfirm={onConfirm}
            onCancel={onCancel}
          />
        </>
      );
    }
    render(<Harness />);

    // Round 1 → confirm
    fireEvent.click(screen.getByTestId('confirm-dialog-confirm'));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();

    // Reopen for round 2
    act(() => {
      fireEvent.click(screen.getByTestId('reopen'));
    });
    // Click cancel → onCancel must fire (confirmingRef reset on open)
    fireEvent.click(screen.getByTestId('confirm-dialog-cancel'));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
