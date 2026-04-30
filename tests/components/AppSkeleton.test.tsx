// UT for src/components/AppSkeleton.tsx — the pre-hydrate placeholder.
// Pin the contract documented at the top of AppSkeleton.tsx so the
// harness-ui startup-paints-before-hydrate case keeps working:
//   * sidebar root: data-testid="sidebar-skeleton" with aria-busy
//   * sidebar new-session row: data-testid="sidebar-skeleton-newsession"
//   * sidebar session rows: data-testid="sidebar-skeleton-row" (>=1)
//   * main root: data-testid="main-skeleton"
//   * main loading affordance: data-testid="main-skeleton-loading"
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppSkeleton } from '../../src/components/AppSkeleton';
import { resetStore } from '../util/resetStore';

afterEach(() => cleanup());
beforeEach(() => resetStore());

describe('<AppSkeleton />', () => {
  it('exposes the testid contract documented for harness-ui', () => {
    const { getByTestId, getAllByTestId } = render(<AppSkeleton />);
    const sidebar = getByTestId('sidebar-skeleton');
    expect(sidebar).toBeInTheDocument();
    expect(sidebar.getAttribute('aria-busy')).toBe('true');

    expect(getByTestId('sidebar-skeleton-newsession')).toBeInTheDocument();
    expect(getAllByTestId('sidebar-skeleton-row').length).toBeGreaterThanOrEqual(1);

    const main = getByTestId('main-skeleton');
    expect(main).toBeInTheDocument();
    expect(main.getAttribute('aria-busy')).toBe('true');

    expect(getByTestId('main-skeleton-loading')).toBeInTheDocument();
  });

  it('sidebar uses the documented 260px width', () => {
    const { getByTestId } = render(<AppSkeleton />);
    const sidebar = getByTestId('sidebar-skeleton');
    expect((sidebar as HTMLElement).style.width).toBe('260px');
  });
});
