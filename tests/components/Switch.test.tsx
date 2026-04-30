// UT for src/components/ui/Switch.tsx — Radix-backed toggle primitive.
// Verifies the visual contract documented at the top of Switch.tsx:
//   * role="switch" and aria-checked are wired by Radix
//   * controlled / uncontrolled pattern via `checked` + `onCheckedChange`
//   * disabled state blocks toggling and applies the disabled style
//   * aria-label flows through (so screen readers have a name)
//   * defaultChecked initializes the uncontrolled state
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Switch } from '../../src/components/ui/Switch';

afterEach(() => cleanup());

describe('<Switch />', () => {
  it('renders with role="switch" and exposes the aria-label', () => {
    const { getByRole } = render(<Switch aria-label="notify-on-stop" />);
    const sw = getByRole('switch');
    expect(sw).toBeInTheDocument();
    expect(sw.getAttribute('aria-label')).toBe('notify-on-stop');
  });

  it('reflects defaultChecked via aria-checked + data-state', () => {
    const { getByRole } = render(<Switch defaultChecked aria-label="x" />);
    const sw = getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('true');
    expect(sw.getAttribute('data-state')).toBe('checked');
  });

  it('controlled mode: clicking fires onCheckedChange with the next value', () => {
    const onCheckedChange = vi.fn(function (_v: boolean) {});
    const { getByRole, rerender } = render(
      <Switch checked={false} onCheckedChange={onCheckedChange} aria-label="x" />
    );
    const sw = getByRole('switch');
    expect(sw.getAttribute('aria-checked')).toBe('false');

    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenCalledWith(true);

    // Caller flips the controlled prop
    rerender(<Switch checked={true} onCheckedChange={onCheckedChange} aria-label="x" />);
    expect(sw.getAttribute('aria-checked')).toBe('true');

    fireEvent.click(sw);
    expect(onCheckedChange).toHaveBeenLastCalledWith(false);
  });

  it('disabled blocks onCheckedChange', () => {
    const onCheckedChange = vi.fn(function (_v: boolean) {});
    const { getByRole } = render(
      <Switch disabled aria-label="x" onCheckedChange={onCheckedChange} />
    );
    const sw = getByRole('switch');
    expect(sw).toBeDisabled();
    fireEvent.click(sw);
    expect(onCheckedChange).not.toHaveBeenCalled();
  });

  it('disabled applies the cursor-not-allowed class on the root', () => {
    const { getByRole } = render(<Switch disabled aria-label="x" />);
    const sw = getByRole('switch');
    expect(sw.className).toMatch(/cursor-not-allowed/);
  });

  it('forwards extra className to the root', () => {
    const { getByRole } = render(<Switch aria-label="x" className="extra-token" />);
    expect(getByRole('switch').className).toMatch(/extra-token/);
  });
});
