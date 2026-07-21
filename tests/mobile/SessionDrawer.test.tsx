// TDD tests for `SessionDrawer` (mobile composer/terminal-sync plan, Task 5).
// Wraps the shared touch-density SessionNavigator as a temporary, accessible
// overlay. Per the final user override, this drawer has NO programmatic
// focus trap and NO focus restoration — it stays accessible through
// role/aria plus Escape/backdrop/session-close, and it must never call
// focus() or blur() anywhere.

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { SessionDrawer } from '../../src/mobile/components/SessionDrawer';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator';

function model(overrides: Partial<SessionNavigatorModel> = {}): SessionNavigatorModel {
  return {
    groups: [
      {
        id: 'g1',
        name: 'Group 1',
        order: 0,
        collapsed: false,
        sessions: [
          { id: 's1', name: 'Session One', cwd: '/repo/one', state: 'idle', order: 0 },
          { id: 's2', name: 'Session Two', cwd: '/repo/two', state: 'active', order: 1 },
        ],
      },
    ],
    activeSessionId: null,
    ...overrides,
  };
}

describe('SessionDrawer', () => {
  it('renders nothing when closed', () => {
    render(
      <SessionDrawer
        open={false}
        model={model()}
        selectedSessionId={null}
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders an accessible, labelled dialog with the touch-density navigator when open', () => {
    render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAccessibleName();
    expect(within(dialog).getByText('Session One')).toBeInTheDocument();
    expect(within(dialog).getByText('Session Two')).toBeInTheDocument();
  });

  it('reflects the store selectedSessionId, not a stale desktop activeSessionId', () => {
    // The navigator model's own `activeSessionId` (s2) simulates a desktop
    // tab-switch the phone never asked for; the phone's own selection (s1)
    // must win in the drawer's rendering.
    render(
      <SessionDrawer
        open
        model={model({ activeSessionId: 's2' })}
        selectedSessionId="s1"
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    const options = screen.getAllByRole('option');
    const selected = options.find((option) => option.getAttribute('aria-selected') === 'true');
    expect(selected).toHaveTextContent('Session One');
  });

  it('calls onSelectSession with the clicked session id', async () => {
    const user = userEvent.setup();
    const onSelectSession = vi.fn();
    render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={vi.fn()}
        onSelectSession={onSelectSession}
      />,
    );
    await user.click(screen.getByText('Session Two'));
    expect(onSelectSession).toHaveBeenCalledWith('s2');
  });

  it('closes on Escape without moving focus anywhere', () => {
    const onClose = vi.fn();
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={vi.fn()}
      />,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    blurSpy.mockRestore();
  });

  it('does not close on unrelated keys', () => {
    const onClose = vi.fn();
    render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={vi.fn()}
      />,
    );
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on a backdrop pointer action', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { container } = render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={vi.fn()}
      />,
    );
    const backdrop = container.querySelector('.session-drawer__backdrop') as HTMLElement;
    expect(backdrop).not.toBeNull();
    await user.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('closes via an explicit close control', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('locks body scroll while open and restores the previous value on close', () => {
    document.body.style.overflow = 'scroll';
    function Harness() {
      const [open, setOpen] = useState(true);
      return (
        <div>
          <button type="button" onClick={() => setOpen(false)}>
            toggle
          </button>
          <SessionDrawer
            open={open}
            model={model()}
            selectedSessionId="s1"
            onClose={vi.fn()}
            onSelectSession={vi.fn()}
          />
        </div>
      );
    }
    const { unmount } = render(<Harness />);
    expect(document.body.style.overflow).toBe('hidden');
    unmount();
    expect(document.body.style.overflow).toBe('scroll');
    document.body.style.overflow = '';
  });

  it('restores previous body overflow when closed via prop change (not unmount)', () => {
    document.body.style.overflow = '';
    function Harness({ open }: { open: boolean }) {
      return (
        <SessionDrawer
          open={open}
          model={model()}
          selectedSessionId="s1"
          onClose={vi.fn()}
          onSelectSession={vi.fn()}
        />
      );
    }
    const { rerender } = render(<Harness open />);
    expect(document.body.style.overflow).toBe('hidden');
    rerender(<Harness open={false} />);
    expect(document.body.style.overflow).toBe('');
  });

  it('maintains local collapsed-group overrides without mutating the model prop', async () => {
    const user = userEvent.setup();
    const sharedModel = model();
    const frozenGroups = JSON.stringify(sharedModel.groups);
    render(
      <SessionDrawer
        open
        model={sharedModel}
        selectedSessionId="s1"
        onClose={vi.fn()}
        onSelectSession={vi.fn()}
      />,
    );
    await user.click(screen.getByRole('button', { name: /Group 1/ }));
    expect(JSON.stringify(sharedModel.groups)).toBe(frozenGroups);
  });

  it('never calls focus() or blur() itself while opening, navigating, or closing', () => {
    // Uses `fireEvent.click` rather than `userEvent.click` — a real user
    // tap naturally focuses the tapped element via the browser's own
    // default behavior, which is not app-driven focus management. This
    // test isolates whatever the *component's own* handlers do, which per
    // the final no-app-focus override must never include focus()/blur().
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    const onSelectSession = vi.fn();
    const onClose = vi.fn();
    const { rerender } = render(
      <SessionDrawer
        open={false}
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );
    rerender(
      <SessionDrawer
        open
        model={model()}
        selectedSessionId="s1"
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );
    fireEvent.click(screen.getByText('Session Two'));
    rerender(
      <SessionDrawer
        open={false}
        model={model()}
        selectedSessionId="s2"
        onClose={onClose}
        onSelectSession={onSelectSession}
      />,
    );
    expect(focusSpy).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    blurSpy.mockRestore();
  });
});
