// Unit tests for the Switch primitive (#288).
//
// We render the bare <Switch /> in three modes (off, on, disabled), assert the
// Radix-driven `aria-checked` semantics + `role="switch"`, and verify that a
// click flips the controlled callback. Visual styling (track color, thumb
// translation) is covered by the per-PR before/after screenshots in
// dogfood-logs/, not here — these tests guard the contract, not the chrome.
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from '../src/components/ui/Switch';

afterEach(() => cleanup());

describe('Switch', () => {
  it('renders with role="switch" and aria-checked=false by default', () => {
    render(<Switch checked={false} onCheckedChange={() => {}} aria-label="notif-enable" />);
    const sw = screen.getByRole('switch', { name: 'notif-enable' });
    expect(sw).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('data-state')).toBe('unchecked');
  });

  it('reflects aria-checked=true when checked', () => {
    render(<Switch checked onCheckedChange={() => {}} aria-label="notif-sound" />);
    const sw = screen.getByRole('switch', { name: 'notif-sound' });
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('data-state')).toBe('checked');
  });

  it('fires onCheckedChange with the new value when clicked', () => {
    const onCheckedChange = vi.fn();
    render(<Switch checked={false} onCheckedChange={onCheckedChange} aria-label="notif-question" />);
    fireEvent.click(screen.getByRole('switch'));
    expect(onCheckedChange).toHaveBeenCalledTimes(1);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('does not fire onCheckedChange when disabled', () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch
        checked={false}
        disabled
        onCheckedChange={onCheckedChange}
        aria-label="notif-disabled"
      />
    );
    const sw = screen.getByRole('switch');
    expect(sw.hasAttribute('disabled')).toBe(true);
    fireEvent.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });
});
