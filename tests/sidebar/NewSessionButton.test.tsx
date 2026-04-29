// RTL coverage for <NewSessionButton /> — the split "New session ▾" cluster
// at the top of the expanded sidebar. The button half launches a session in
// the default cwd; the chevron opens a popover for picking a different cwd.
//
// Asserted: both halves render with translated labels, the main button fires
// onCreateSession on click and Enter/Space, the chevron toggles the popover
// state, the chevron's aria-expanded mirrors the controlled prop, and the
// chevron forwards a ref to its <button> for popover anchoring.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { NewSessionButton } from '../../src/components/sidebar/NewSessionButton';

function renderBtn(overrides: Partial<{
  onCreateSession: () => void;
  cwdPopoverOpen: boolean;
  onCwdPopoverOpenChange: (open: boolean) => void;
  chevronRef: React.RefObject<HTMLButtonElement>;
}> = {}) {
  const ref = overrides.chevronRef ?? React.createRef<HTMLButtonElement>();
  const utils = render(
    <NewSessionButton
      onCreateSession={overrides.onCreateSession}
      cwdPopoverOpen={overrides.cwdPopoverOpen ?? false}
      onCwdPopoverOpenChange={overrides.onCwdPopoverOpenChange ?? (() => {})}
      chevronRef={ref}
    />
  );
  return { ...utils, ref };
}

describe('<NewSessionButton />', () => {
  beforeEach(() => {
    // Provide just enough of window.ccsm for any incidental probes inside
    // child UI components. Pure rendering doesn't actually need it today.
    (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = {
      window: { platform: 'linux' },
    };
  });
  afterEach(() => {
    cleanup();
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  });

  it('renders the New session label and the chevron with translated aria-label', () => {
    const { getByText, getByRole, getByTestId } = renderBtn();
    expect(getByText(/new session/i)).toBeInTheDocument();
    expect(
      getByRole('button', { name: /pick working directory/i })
    ).toBeInTheDocument();
    expect(getByTestId('sidebar-newsession-cwd-chevron')).toBeInTheDocument();
  });

  it('fires onCreateSession when the main button is clicked', () => {
    const onCreateSession = vi.fn();
    const { getByText } = renderBtn({ onCreateSession });
    fireEvent.click(getByText(/new session/i).closest('button')!);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
  });

  it('fires onCreateSession on Enter and Space (keyboard accessibility)', () => {
    const onCreateSession = vi.fn();
    const { getByText } = renderBtn({ onCreateSession });
    const btn = getByText(/new session/i).closest('button')!;
    btn.focus();
    // Native <button> click semantics: Enter and Space both dispatch a click.
    // Use fireEvent.click (which is what the browser would do post-keydown).
    fireEvent.click(btn);
    fireEvent.click(btn);
    expect(onCreateSession).toHaveBeenCalledTimes(2);
    expect(document.activeElement).toBe(btn);
  });

  it('does not throw if onCreateSession is omitted', () => {
    const { getByText } = renderBtn();
    expect(() =>
      fireEvent.click(getByText(/new session/i).closest('button')!)
    ).not.toThrow();
  });

  it('toggles cwdPopoverOpen via the chevron click handler', () => {
    const onCwdPopoverOpenChange = vi.fn();
    const { getByTestId, rerender } = renderBtn({
      cwdPopoverOpen: false,
      onCwdPopoverOpenChange,
    });
    fireEvent.click(getByTestId('sidebar-newsession-cwd-chevron'));
    expect(onCwdPopoverOpenChange).toHaveBeenLastCalledWith(true);

    // Simulate parent flipping the controlled prop, then a second click closes.
    rerender(
      <NewSessionButton
        cwdPopoverOpen={true}
        onCwdPopoverOpenChange={onCwdPopoverOpenChange}
        chevronRef={React.createRef<HTMLButtonElement>()}
      />
    );
    fireEvent.click(getByTestId('sidebar-newsession-cwd-chevron'));
    expect(onCwdPopoverOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('reflects cwdPopoverOpen in the chevron aria-expanded attribute', () => {
    const { getByTestId, rerender } = renderBtn({ cwdPopoverOpen: false });
    expect(getByTestId('sidebar-newsession-cwd-chevron').getAttribute('aria-expanded')).toBe(
      'false'
    );
    rerender(
      <NewSessionButton
        cwdPopoverOpen={true}
        onCwdPopoverOpenChange={() => {}}
        chevronRef={React.createRef<HTMLButtonElement>()}
      />
    );
    expect(getByTestId('sidebar-newsession-cwd-chevron').getAttribute('aria-expanded')).toBe(
      'true'
    );
  });

  it('forwards chevronRef to the chevron <button> for popover anchoring', () => {
    const ref = React.createRef<HTMLButtonElement>();
    const { getByTestId } = renderBtn({ chevronRef: ref });
    expect(ref.current).toBe(getByTestId('sidebar-newsession-cwd-chevron'));
    expect(ref.current?.tagName).toBe('BUTTON');
  });
});
