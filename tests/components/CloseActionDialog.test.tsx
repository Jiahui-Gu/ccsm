// UT for src/components/CloseActionDialog.tsx (#1253) — the in-app
// replacement for the native close confirmation. Covers the
// resolve-payload contract that the component file documents:
//   * Tray / Quit / Cancel each fire onResolve with their respective
//     choice + the current dontAskAgain state.
//   * Cancel via Esc / outside click / X also routes to onResolve as
//     'cancel' so main can clear its pending-ask gate (otherwise
//     subsequent X clicks would be silently swallowed).
//   * onResolve fires AT MOST ONCE per open — the dialog must not
//     double-answer main.
//   * dontAskAgain checkbox value rides along with every choice; the
//     POLICY that 'cancel' never persists is enforced on the main
//     side (`decideCloseAction`), not here — this component just
//     forwards raw user input.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import {
  CloseActionDialog,
  type CloseActionLabels,
} from '../../src/components/CloseActionDialog';

afterEach(() => cleanup());

const LABELS: CloseActionLabels = {
  message: 'Close ccsm?',
  detail: 'Minimize to tray keeps ccsm running.',
  tray: 'Minimize to tray',
  quit: 'Quit',
  cancel: 'Cancel',
  dontAskAgain: "Don't ask again",
};

function setup(
  override: Partial<React.ComponentProps<typeof CloseActionDialog>> = {}
) {
  const onOpenChange = vi.fn(function (_o: boolean) {});
  const onResolve = vi.fn(function (_r: {
    choice: 'tray' | 'quit' | 'cancel';
    dontAskAgain: boolean;
  }) {});
  const utils = render(
    <CloseActionDialog
      open
      onOpenChange={onOpenChange}
      labels={LABELS}
      onResolve={onResolve}
      {...override}
    />
  );
  return { ...utils, onOpenChange, onResolve };
}

describe('<CloseActionDialog /> (#1253)', () => {
  it('renders message, detail, three buttons, and the checkbox', () => {
    setup();
    expect(screen.getByText(LABELS.message)).toBeInTheDocument();
    expect(screen.getByText(LABELS.detail)).toBeInTheDocument();
    expect(screen.getByTestId('close-action-tray')).toHaveTextContent(LABELS.tray);
    expect(screen.getByTestId('close-action-quit')).toHaveTextContent(LABELS.quit);
    expect(screen.getByTestId('close-action-cancel')).toHaveTextContent(LABELS.cancel);
    expect(screen.getByTestId('close-action-dontask')).not.toBeChecked();
  });

  it('tray button resolves with { choice: tray, dontAskAgain: false } by default', () => {
    const { onResolve, onOpenChange } = setup();
    fireEvent.click(screen.getByTestId('close-action-tray'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'tray', dontAskAgain: false });
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('quit button resolves with choice=quit', () => {
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId('close-action-quit'));
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'quit', dontAskAgain: false });
  });

  it('cancel button resolves with choice=cancel', () => {
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId('close-action-cancel'));
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'cancel', dontAskAgain: false });
  });

  it('checking "don\'t ask again" rides along with the chosen action', () => {
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId('close-action-dontask'));
    fireEvent.click(screen.getByTestId('close-action-quit'));
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'quit', dontAskAgain: true });
  });

  it('cancel + dontAskAgain forwards the raw user input (policy enforced elsewhere)', () => {
    // The component does NOT enforce "cancel never persists" — that lives
    // in `decideCloseAction` on main. The dialog forwards both signals
    // verbatim so a future UI change (e.g. disable the checkbox when
    // cancel is focused) doesn't accidentally drift the contract.
    const { onResolve } = setup();
    fireEvent.click(screen.getByTestId('close-action-dontask'));
    fireEvent.click(screen.getByTestId('close-action-cancel'));
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'cancel', dontAskAgain: true });
  });

  it('onResolve fires at most once per open even with rapid double-clicks', () => {
    const { onResolve } = setup();
    const tray = screen.getByTestId('close-action-tray');
    fireEvent.click(tray);
    fireEvent.click(tray);
    fireEvent.click(screen.getByTestId('close-action-quit'));
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'tray', dontAskAgain: false });
  });

  it('closing via the X button routes through onResolve as cancel', () => {
    // Radix's <DialogClose> at the top-right triggers onOpenChange(false)
    // without a choice click — we must still answer main so its pending
    // ask gate clears. The component synthesizes a `'cancel'` reply on
    // any unresolved dismiss.
    const { onResolve, onOpenChange } = setup();
    // Find the dialog close (X) — the only IconButton with aria-label
    // 'Close' / 'close' rendered by DialogContent. Use the i18n's actual
    // resolved label via getAllByRole; the X is the only button OUTSIDE
    // our three testids.
    const closeButtons = screen
      .getAllByRole('button')
      .filter((b) => !b.getAttribute('data-testid')?.startsWith('close-action-'));
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[0]);
    // Radix forwards the click → onOpenChange(false). The dialog wraps
    // that path with a synthetic cancel resolve.
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'cancel', dontAskAgain: false });
  });

  it('dismiss after a button click does NOT double-resolve', () => {
    // After a tray click resolves, the parent flips `open` to false via
    // onOpenChange. The subsequent unmount must NOT fire a second
    // cancel reply on top of the legitimate tray one.
    const onResolve = vi.fn();
    function Harness() {
      const [open, setOpen] = React.useState(true);
      return (
        <CloseActionDialog
          open={open}
          onOpenChange={setOpen}
          labels={LABELS}
          onResolve={onResolve}
        />
      );
    }
    render(<Harness />);
    act(() => {
      fireEvent.click(screen.getByTestId('close-action-tray'));
    });
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenLastCalledWith({ choice: 'tray', dontAskAgain: false });
  });
});
