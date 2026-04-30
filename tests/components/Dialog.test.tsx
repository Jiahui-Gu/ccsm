// UT for src/components/ui/Dialog.tsx — covers the surface this file owns
// on top of Radix:
//   * DialogContent renders title + description in role="dialog"
//   * data-modal-dialog marker is present (consumed by InputBar's Esc handler)
//   * close (X) button is rendered by default and dispatches the right close
//   * hideClose=true suppresses the X button
//   * DialogBody / DialogFooter render their children with the expected layout
//     hooks (border-t on footer)
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  Dialog,
  DialogContent,
  DialogTrigger,
  DialogBody,
  DialogFooter,
} from '../../src/components/ui/Dialog';

afterEach(() => cleanup());

describe('<Dialog /> primitives', () => {
  it('renders title and description inside a role=dialog when open', () => {
    render(
      <Dialog open>
        <DialogContent title="Settings" description="Configure things.">
          <DialogBody>body</DialogBody>
        </DialogContent>
      </Dialog>
    );
    const dlg = screen.getByRole('dialog');
    expect(dlg).toBeInTheDocument();
    expect(screen.getByText('Settings')).toBeInTheDocument();
    expect(screen.getByText('Configure things.')).toBeInTheDocument();
    expect(screen.getByText('body')).toBeInTheDocument();
  });

  it('marks the modal with data-modal-dialog (InputBar Esc-handler hook)', () => {
    render(
      <Dialog open>
        <DialogContent title="t">x</DialogContent>
      </Dialog>
    );
    expect(screen.getByRole('dialog').hasAttribute('data-modal-dialog')).toBe(true);
  });

  it('renders a close (X) button by default that dispatches the close', () => {
    const onOpenChange = vi.fn(function (_open: boolean) {});
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent title="t">x</DialogContent>
      </Dialog>
    );
    // Close button has aria-label "Close" (from common.close i18n key).
    const close = screen.getByRole('button', { name: /close/i });
    fireEvent.click(close);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('hideClose=true suppresses the close button', () => {
    render(
      <Dialog open>
        <DialogContent title="t" hideClose>
          x
        </DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole('button', { name: /close/i })).toBeNull();
  });

  it('controlled open=false hides the dialog content', () => {
    render(
      <Dialog open={false}>
        <DialogContent title="hidden">x</DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('DialogTrigger opens the dialog when uncontrolled', () => {
    render(
      <Dialog>
        <DialogTrigger asChild>
          <button data-testid="open">open</button>
        </DialogTrigger>
        <DialogContent title="t">x</DialogContent>
      </Dialog>
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.click(screen.getByTestId('open'));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('DialogFooter applies the divider border (border-t)', () => {
    render(
      <Dialog open>
        <DialogContent title="t">
          <DialogFooter>
            <span data-testid="footer-content">f</span>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    );
    const footer = screen.getByTestId('footer-content').parentElement!;
    expect(footer.className).toMatch(/border-t/);
  });
});
