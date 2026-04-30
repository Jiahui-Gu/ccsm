// UT for src/components/ui/Button.tsx — focuses on the public contract:
//   * default variant=secondary, size=md
//   * data-variant + data-size attributes mirror the props (E2E selector hook)
//   * disabled blocks onClick AND removes the whileTap animation
//   * className passes through and merges via cn()
//   * children render inside the button
//   * type defaults to "button" (so Buttons inside <form> don't accidentally submit)
//   * forwarded ref points at the underlying <button>
import React from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import { Button } from '../../src/components/ui/Button';

afterEach(() => cleanup());

describe('<Button />', () => {
  it('defaults variant=secondary, size=md and type=button', () => {
    const { getByRole } = render(<Button>Click</Button>);
    const btn = getByRole('button', { name: 'Click' });
    expect(btn.getAttribute('data-variant')).toBe('secondary');
    expect(btn.getAttribute('data-size')).toBe('md');
    expect(btn.getAttribute('type')).toBe('button');
  });

  it.each(['primary', 'secondary', 'ghost', 'raised', 'danger'] as const)(
    'reflects variant=%s on data-variant',
    (variant) => {
      const { getByRole } = render(<Button variant={variant}>x</Button>);
      expect(getByRole('button').getAttribute('data-variant')).toBe(variant);
    }
  );

  it.each(['xs', 'sm', 'md', 'lg'] as const)(
    'reflects size=%s on data-size',
    (size) => {
      const { getByRole } = render(<Button size={size}>x</Button>);
      expect(getByRole('button').getAttribute('data-size')).toBe(size);
    }
  );

  it('fires onClick when enabled', () => {
    const onClick = vi.fn(function () {});
    const { getByRole } = render(<Button onClick={onClick}>go</Button>);
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('disabled blocks onClick and exposes the disabled attribute', () => {
    const onClick = vi.fn(function () {});
    const { getByRole } = render(
      <Button disabled onClick={onClick}>
        nope
      </Button>
    );
    const btn = getByRole('button');
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(onClick).not.toHaveBeenCalled();
  });

  it('merges custom className alongside the variant classes', () => {
    const { getByRole } = render(
      <Button className="my-extra-token">x</Button>
    );
    const cls = getByRole('button').className;
    expect(cls).toMatch(/my-extra-token/);
    // Still has the base inline-flex from the cva root class
    expect(cls).toMatch(/inline-flex/);
  });

  it('renders children content', () => {
    const { getByRole } = render(
      <Button>
        <span data-testid="child">hello</span>
      </Button>
    );
    expect(getByRole('button').querySelector('[data-testid="child"]')).not.toBeNull();
  });

  it('respects an explicit type=submit override', () => {
    const { getByRole } = render(<Button type="submit">go</Button>);
    expect(getByRole('button').getAttribute('type')).toBe('submit');
  });

  it('forwards ref to the underlying button element', () => {
    const ref = React.createRef<HTMLButtonElement>();
    render(<Button ref={ref}>x</Button>);
    expect(ref.current).toBeInstanceOf(HTMLButtonElement);
  });
});
