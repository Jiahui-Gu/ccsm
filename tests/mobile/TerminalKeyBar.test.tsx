// TDD tests for `TerminalKeyBar` (mobile composer/terminal-sync plan, Task 5).
// Fixed discrete PTY control map only — no sticky modifiers, no arbitrary
// keys, no text streaming, and no focus()/blur() calls on the composer or
// terminal. User/browser-driven focus changes from clicking a button are
// natural DOM behavior and are not something this component (or these
// tests) suppress; the component itself just never calls focus()/blur().

import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { TerminalKeyBar, TERMINAL_KEYS } from '../../src/mobile/components/TerminalKeyBar';

describe('TerminalKeyBar', () => {
  it('emits all discrete Claude TUI controls without focusing the composer', async () => {
    const user = userEvent.setup();
    const onInput = vi.fn();
    render(<TerminalKeyBar enabled onInput={onInput} />);

    const expected = new Map([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['Up', '\x1b[A'],
      ['Down', '\x1b[B'],
      ['Left', '\x1b[D'],
      ['Right', '\x1b[C'],
      ['Space', ' '],
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
      ['Interrupt', '\x03'],
      ['Enter', '\r'],
    ]);

    for (const [name, data] of expected) {
      await user.click(screen.getByRole('button', { name }));
      expect(onInput).toHaveBeenLastCalledWith(data);
    }
    expect(onInput).toHaveBeenCalledTimes(expected.size);
  });

  it('exposes exactly the TERMINAL_KEYS constant map, in order', () => {
    expect(TERMINAL_KEYS.map((key) => [key.ariaLabel, key.data])).toEqual([
      ['Esc', '\x1b'],
      ['Tab', '\t'],
      ['Up', '\x1b[A'],
      ['Down', '\x1b[B'],
      ['Left', '\x1b[D'],
      ['Right', '\x1b[C'],
      ['Space', ' '],
      ['1', '1'],
      ['2', '2'],
      ['3', '3'],
      ['4', '4'],
      ['Interrupt', '\x03'],
      ['Enter', '\r'],
    ]);
  });

  it('disables every key when input is disabled', () => {
    render(<TerminalKeyBar enabled={false} onInput={vi.fn()} />);
    for (const key of TERMINAL_KEYS) {
      expect(screen.getByRole('button', { name: key.ariaLabel })).toBeDisabled();
    }
  });

  it('never calls onInput for a disabled key bar', async () => {
    const user = userEvent.setup({ pointerEventsCheck: 0 });
    const onInput = vi.fn();
    render(<TerminalKeyBar enabled={false} onInput={onInput} />);
    await user.click(screen.getByRole('button', { name: 'Esc' }));
    expect(onInput).not.toHaveBeenCalled();
  });

  it('never calls focus() or blur() itself from a key click', () => {
    // `fireEvent.click` dispatches a bare click event without the browser's
    // native "clicking a button focuses it" side effect that a realistic
    // `userEvent.click` would add — isolating whatever this component's own
    // click handler does. The app-level contract under test is that the
    // component itself never calls focus()/blur() (natural browser focus
    // from a real user tap is expected and is not in scope here).
    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');
    render(<TerminalKeyBar enabled onInput={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Interrupt' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enter' }));
    expect(focusSpy).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
    focusSpy.mockRestore();
    blurSpy.mockRestore();
  });
});
