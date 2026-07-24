// TDD tests for `MessageComposer` (mobile composer/terminal-sync plan, Task 5;
// approved spec "Phone input model", lines 163-201). The composer is a normal
// controlled multiline textarea with NO keydown interception: Return always
// inserts a local newline (native browser/IME behavior untouched), and only
// the explicit Send button submits. Application code here never calls
// `focus()`/`blur()` on anything — the final no-app-focus override
// supersedes any older focus-management text in the plan.

import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { MessageComposer } from '../../src/mobile/components/MessageComposer';

type HarnessProps = {
  initialDraft?: string;
  enabled?: boolean;
  submitting?: boolean;
  error?: string | null;
  onSubmit?: () => void;
};

function ComposerHarness({
  initialDraft = '',
  enabled = true,
  submitting = false,
  error = null,
  onSubmit,
}: HarnessProps) {
  const [draft, setDraft] = useState(initialDraft);
  return (
    <MessageComposer
      draft={draft}
      enabled={enabled}
      submitting={submitting}
      error={error}
      onDraftChange={setDraft}
      onSubmit={onSubmit}
    />
  );
}

describe('MessageComposer', () => {
  it('keeps Return as a local newline and submits only from Send', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn();
    render(<ComposerHarness onSubmit={onSubmit} />);

    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, 'first{enter}第二行');

    expect(input).toHaveValue('first\n第二行');
    expect(onSubmit).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    expect(onSubmit).toHaveBeenCalledOnce();
  });

  it('preserves the visible draft and disables Send while disconnected', () => {
    render(<MessageComposer draft="keep me" enabled={false} submitting={false} />);
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('keep me');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables Send for an empty draft even while connected', () => {
    render(<MessageComposer draft="" enabled submitting={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables Send for a whitespace-only draft', () => {
    render(<MessageComposer draft="   " enabled submitting={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('disables Send while a submission is pending, even with a non-empty draft', () => {
    render(<MessageComposer draft="hello" enabled submitting />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  it('enables Send once connected, non-empty, and not submitting', () => {
    render(<MessageComposer draft="hello" enabled submitting={false} />);
    expect(screen.getByRole('button', { name: 'Send' })).toBeEnabled();
  });

  it('renders a submission error as a visible alert', () => {
    render(<MessageComposer draft="hello" enabled submitting={false} error="submission_rejected" />);
    expect(screen.getByRole('alert')).toHaveTextContent('submission_rejected');
  });

  it('renders no alert when there is no error', () => {
    render(<MessageComposer draft="hello" enabled submitting={false} error={null} />);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('calls onDraftChange for every keystroke without submitting', async () => {
    const user = userEvent.setup();
    const onDraftChange = vi.fn();
    const onSubmit = vi.fn();
    render(
      <MessageComposer
        draft=""
        enabled
        submitting={false}
        onDraftChange={onDraftChange}
        onSubmit={onSubmit}
      />,
    );
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hi');
    expect(onDraftChange).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('never calls focus() or blur() itself while editing props after typing/sending', async () => {
    // Real typing/clicking legitimately involves the browser's own native
    // focus behavior (userEvent simulates a real user, who does focus the
    // field they type into and the button they click) — that is not
    // app-driven focus management. What must never happen is the
    // *component* itself imperatively moving focus, e.g. in response to
    // prop changes such as becoming disabled, entering "submitting", or
    // receiving an error. So we let the natural interaction happen first,
    // then reset the spies and assert zero further focus/blur calls across
    // prop-only re-renders.
    const user = userEvent.setup();
    const onSubmit = vi.fn();

    const { rerender } = render(<ComposerHarness onSubmit={onSubmit} />);
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello{enter}world');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');

    rerender(<ComposerHarness enabled={false} onSubmit={onSubmit} />);
    rerender(<ComposerHarness submitting onSubmit={onSubmit} />);
    rerender(<ComposerHarness error="oops" onSubmit={onSubmit} />);

    expect(focusSpy).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    blurSpy.mockRestore();
  });

  it('does not intercept keydown: Enter never prevents default or blocks the newline', async () => {
    const user = userEvent.setup();
    render(<ComposerHarness />);
    const input = screen.getByRole('textbox', { name: 'Message' }) as HTMLTextAreaElement;
    const keydownSpy = vi.fn();
    input.addEventListener('keydown', keydownSpy);
    await user.type(input, 'a{enter}b');
    expect(input.value).toBe('a\nb');
    // The component itself must not attach any keydown handler of its own —
    // this only verifies native/testing-library dispatch reached the DOM
    // uninterrupted (no synthetic preventDefault stopped propagation).
    expect(keydownSpy).toHaveBeenCalled();
  });
});
