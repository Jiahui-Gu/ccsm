// UT for src/components/chrome/TopBanner.tsx — the unified top-of-pane
// status strip + its CTA primitive. Coverage:
//   * variant drives both data-variant and ARIA role (error → alert,
//     warning/info → status)
//   * title / body / icon / actions / dismiss all render in their slots
//   * dismiss button calls onDismiss with the supplied label (default: Dismiss)
//   * testId hook lands on the outer wrapper
//   * TopBannerAction renders a <button type="button"> with the right
//     tone-class hooks and forwards onClick / disabled / aria-label
//   * TopBannerStack adds the stack className that suppresses inner borders
//   * TopBannerPresence is a transparent passthrough for AnimatePresence
import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/react';
import {
  TopBanner,
  TopBannerAction,
  TopBannerStack,
  TopBannerPresence,
} from '../../src/components/chrome/TopBanner';

afterEach(() => cleanup());

describe('<TopBanner />', () => {
  it.each([
    ['error', 'alert'],
    ['warning', 'status'],
    ['info', 'status'],
  ] as const)('variant=%s sets ARIA role=%s', (variant, role) => {
    const { container } = render(
      <TopBanner variant={variant} title="t" testId={`b-${variant}`} />
    );
    const wrap = container.querySelector(`[data-testid="b-${variant}"]`)!;
    expect(wrap.getAttribute('data-variant')).toBe(variant);
    expect(wrap.querySelector(`[role="${role}"]`)).not.toBeNull();
  });

  it('renders title, body and icon in the expected slots', () => {
    const { getByText, container } = render(
      <TopBanner
        variant="error"
        icon={<svg aria-hidden data-testid="icon" />}
        title="Failed to start"
        body="exit-code 127"
        testId="b1"
      />
    );
    expect(getByText('Failed to start')).toBeInTheDocument();
    expect(getByText('exit-code 127')).toBeInTheDocument();
    expect(container.querySelector('[data-testid="icon"]')).not.toBeNull();
  });

  it('renders ReactNode body (not just strings)', () => {
    const { getByTestId } = render(
      <TopBanner
        variant="info"
        title="t"
        body={<a data-testid="link" href="#x">retry</a>}
        testId="b1"
      />
    );
    expect(getByTestId('link')).toBeInTheDocument();
  });

  it('actions render in the actions container', () => {
    const { container } = render(
      <TopBanner
        variant="warning"
        title="t"
        actions={<button data-testid="action">go</button>}
        testId="b1"
      />
    );
    const actionsRoot = container.querySelector('[data-top-banner-actions]')!;
    expect(actionsRoot.querySelector('[data-testid="action"]')).not.toBeNull();
  });

  it('dismiss button is omitted when onDismiss is not supplied', () => {
    const { container } = render(
      <TopBanner variant="info" title="t" testId="b1" />
    );
    expect(container.querySelector('[data-top-banner-dismiss]')).toBeNull();
  });

  it('dismiss button fires onDismiss and uses the default aria-label "Dismiss"', () => {
    const onDismiss = vi.fn(function () {});
    const { container } = render(
      <TopBanner variant="info" title="t" onDismiss={onDismiss} testId="b1" />
    );
    const dismiss = container.querySelector(
      '[data-top-banner-dismiss]'
    ) as HTMLButtonElement;
    expect(dismiss).not.toBeNull();
    expect(dismiss.getAttribute('aria-label')).toBe('Dismiss');
    fireEvent.click(dismiss);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('dismiss button respects a custom aria-label', () => {
    const { container } = render(
      <TopBanner
        variant="info"
        title="t"
        onDismiss={() => {}}
        dismissLabel="Hide"
        testId="b1"
      />
    );
    const dismiss = container.querySelector(
      '[data-top-banner-dismiss]'
    ) as HTMLButtonElement;
    expect(dismiss.getAttribute('aria-label')).toBe('Hide');
  });

  it('omits the body block when body is undefined', () => {
    const { container, getByText } = render(
      <TopBanner variant="info" title="just title" testId="b1" />
    );
    expect(getByText('just title')).toBeInTheDocument();
    // Only one span sibling (the title) inside the text col; no body span.
    const statusRow = container.querySelector('[role="status"]')!;
    const textCol = statusRow.querySelector('div.flex-1')!;
    expect(textCol.querySelectorAll('span').length).toBe(1);
  });
});

describe('<TopBannerAction />', () => {
  it('renders <button type="button"> by default', () => {
    const { getByRole } = render(<TopBannerAction>Retry</TopBannerAction>);
    const btn = getByRole('button', { name: 'Retry' });
    expect(btn.getAttribute('type')).toBe('button');
  });

  it('forwards onClick + disabled', () => {
    const onClick = vi.fn(function () {});
    const { getByRole } = render(
      <TopBannerAction onClick={onClick}>go</TopBannerAction>
    );
    fireEvent.click(getByRole('button'));
    expect(onClick).toHaveBeenCalledTimes(1);

    cleanup();

    const onClick2 = vi.fn(function () {});
    const r2 = render(
      <TopBannerAction disabled onClick={onClick2}>
        no
      </TopBannerAction>
    );
    fireEvent.click(r2.getByRole('button'));
    expect(onClick2).not.toHaveBeenCalled();
    expect(r2.getByRole('button')).toBeDisabled();
  });

  it.each(['primary', 'secondary', 'neutral', 'dismiss'] as const)(
    'tone=%s applies its tone-class hook',
    (tone) => {
      const { getByRole } = render(
        <TopBannerAction tone={tone}>x</TopBannerAction>
      );
      // tone classes use bg-black/<n>; we only assert the bg-black token shows up
      expect(getByRole('button').className).toMatch(/bg-black\/\d+/);
    }
  );

  it.each(['pill', 'square'] as const)(
    'shape=%s applies the matching size class',
    (shape) => {
      const { getByRole } = render(
        <TopBannerAction shape={shape}>x</TopBannerAction>
      );
      const cls = getByRole('button').className;
      if (shape === 'pill') expect(cls).toMatch(/h-7 px-2\.5/);
      else expect(cls).toMatch(/h-7 w-7/);
    }
  );
});

describe('<TopBannerStack /> + <TopBannerPresence />', () => {
  it('TopBannerStack wraps children in the suppress-inner-border container', () => {
    const { container } = render(
      <TopBannerStack>
        <span data-testid="child" />
      </TopBannerStack>
    );
    const stack = container.querySelector('[data-top-banner-stack]')!;
    expect(stack).not.toBeNull();
    expect(stack.querySelector('[data-testid="child"]')).not.toBeNull();
  });

  it('TopBannerPresence renders its children (transparent passthrough)', () => {
    const { getByTestId } = render(
      <TopBannerPresence>
        <span data-testid="kid">x</span>
      </TopBannerPresence>
    );
    expect(getByTestId('kid')).toBeInTheDocument();
  });
});
