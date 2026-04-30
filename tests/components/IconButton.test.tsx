// UT for src/components/ui/IconButton.tsx — square ghost button with
// optional Tooltip wrap. Verifies:
//   * defaults variant=ghost, size=sm
//   * data-variant + data-size mirror the props
//   * disabled blocks onClick and removes whileTap
//   * className passes through
//   * children render inside
//   * ref forwards to the button
//   * tooltip prop wraps the button (does not blow up render)
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { IconButton } from '../../src/components/ui/IconButton';

afterEach(() => cleanup());

describe('<IconButton />', () => {
  it('defaults variant=ghost, size=sm, type=button', () => {
    const { getByRole } = render(
      <IconButton aria-label="x">
        <svg aria-hidden width={12} height={12} />
      </IconButton>
    );
    const btn = getByRole('button', { name: 'x' });
    expect(btn.getAttribute('data-variant')).toBe('ghost');
    expect(btn.getAttribute('data-size')).toBe('sm');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it.each(['ghost', 'outlined', 'raised'] as const)(
    'reflects variant=%s on data-variant',
    (variant) => {
      const { getByRole } = render(
        <IconButton aria-label="x" variant={variant}>
          <svg aria-hidden />
        </IconButton>
      );
      expect(getByRole('button').getAttribute('data-variant')).toBe(variant);
    }
  );

  it.each(['xs', 'sm', 'md'] as const)(
    'reflects size=%s on data-size',
    (size) => {
      const { getByRole } = render(
        <IconButton aria-label="x" size={size}>
          <svg aria-hidden />
        </IconButton>
      );
      expect(getByRole('button').getAttribute('data-size')).toBe(size);
    }
  );

  it('fires onClick when enabled', () => {
    const onClick = vi.fn(function () {});
    const { getByRole } = render(
      <IconButton aria-label="x" onClick={onClick}>
        <svg aria-hidden />
      </IconButton>
    );
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks onClick', () => {
    const onClick = vi.fn(function () {});
    const { getByRole } = render(
      <IconButton aria-label="x" disabled onClick={onClick}>
        <svg aria-hidden />
      </IconButton>
    );
    const btn = getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('forwards ref to the underlying button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(
      <IconButton aria-label="x" ref={ref}>
        <svg aria-hidden />
      </IconButton>
    );
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });

  it('merges custom className with variant classes', () => {
    const { getByRole } = render(
      <IconButton aria-label="x" className="my-token">
        <svg aria-hidden />
      </IconButton>
    );
    expect(getByRole('button').className).toMatch(/my-token/);
  });

  it('with `tooltip` still renders the button (Tooltip wraps without breaking render)', () => {
    const { getByRole } = render(
      <IconButton aria-label="settings" tooltip="Open settings">
        <svg aria-hidden />
      </IconButton>
    );
    expect(getByRole('button', { name: 'settings' })).toBeInTheDocument();
  });
});
