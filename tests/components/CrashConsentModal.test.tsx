// UT for src/components/CrashConsentModal.tsx — covers the product surface
// the e2e harness can't see. The harness setup auto-dismisses this modal,
// so without these UTs the persist contract / data-* selectors / focus-
// trap blockers are 0-coverage and would silently regress (breaking both
// first-run UX and the harness setup itself).
//
// Coverage:
//   * does not open when persisted consent is already non-pending
//   * Allow button → window.ccsm.saveState('crashUploadConsent','opted-in')
//     and modal closes
//   * Not now button → saveState('crashUploadConsent','opted-out')
//     and modal closes (data-crash-consent-not-now selector — used by
//     the e2e harness setup to dismiss the modal)
//   * Esc keydown is preventDefault'd: modal stays open, no persist
//   * outside pointerdown is preventDefault'd: modal stays open, no persist
//
// NB: the task spec asked for "overlay click → opted-out" as a separate
// product surface, but production preventDefault's onPointerDownOutside
// (so overlay click does NOT close the modal — the only opted-out exit
// is the Not now button). The Esc + outside-pointerdown tests assert
// that blocked-close contract; the Not now test covers the opted-out
// persist path.
import React from 'react';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { CrashConsentModal } from '../../src/components/CrashConsentModal';

type CcsmStub = {
  loadState: ReturnType<typeof vi.fn>;
  saveState: ReturnType<typeof vi.fn>;
};

function installCcsm(initial: string | null = 'pending'): CcsmStub {
  const stub: CcsmStub = {
    loadState: vi.fn(function (_key: string) {
      return Promise.resolve(initial);
    }),
    saveState: vi.fn(function (_key: string, _value: string) {
      return Promise.resolve();
    }),
  };
  (window as unknown as { ccsm: CcsmStub }).ccsm = stub;
  return stub;
}

async function renderOpen(): Promise<CcsmStub> {
  const stub = installCcsm('pending');
  await act(async () => {
    render(<CrashConsentModal />);
    // flush the loadState() microtask chain so useEffect opens the modal
    await Promise.resolve();
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });
  return stub;
}

afterEach(() => {
  cleanup();
  delete (window as unknown as { ccsm?: unknown }).ccsm;
});

beforeEach(() => {
  delete (window as unknown as { ccsm?: unknown }).ccsm;
});

describe('<CrashConsentModal />', () => {
  it('does NOT open when persisted consent is already opted-in', async () => {
    installCcsm('opted-in');
    await act(async () => {
      render(<CrashConsentModal />);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Allow button persists consent as opted-in and closes the modal', async () => {
    const stub = await renderOpen();
    const allow = document.querySelector(
      '[data-crash-consent-allow]'
    ) as HTMLButtonElement | null;
    expect(allow).not.toBeNull();

    fireEvent.click(allow!);

    expect(stub.saveState).toHaveBeenCalledWith('crashUploadConsent', 'opted-in');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Not now button persists consent as opted-out and closes the modal', async () => {
    const stub = await renderOpen();
    // The data-crash-consent-not-now selector is the e2e harness's
    // entry point for dismissing this modal during test setup. If it
    // disappears or moves, every harness boots into a stuck modal.
    const notNow = document.querySelector(
      '[data-crash-consent-not-now]'
    ) as HTMLButtonElement | null;
    expect(notNow).not.toBeNull();

    fireEvent.click(notNow!);

    expect(stub.saveState).toHaveBeenCalledWith('crashUploadConsent', 'opted-out');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).toBeNull();
    });
  });

  it('Esc keydown is preventDefault-ed: modal stays open, no persist', async () => {
    const stub = await renderOpen();
    const dialog = screen.getByRole('dialog');

    // Radix listens for Escape on the content; the component's
    // onEscapeKeyDown handler calls preventDefault, so the close
    // pipeline must NOT fire onOpenChange and must NOT persist.
    fireEvent.keyDown(dialog, { key: 'Escape', code: 'Escape' });

    expect(stub.saveState).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('outside pointerdown is preventDefault-ed: modal stays open, no persist', async () => {
    const stub = await renderOpen();

    // Simulate a pointerdown on the document body (outside the dialog
    // content). Radix routes this through onPointerDownOutside, which
    // the component preventDefault's — close pipeline must NOT fire.
    await act(async () => {
      fireEvent.pointerDown(document.body);
      fireEvent.mouseDown(document.body);
      await Promise.resolve();
    });

    expect(stub.saveState).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

});
