// UT for src/components/AppShell.tsx — the two-pane shell. Verifies:
//   * sidebar + main slots both render
//   * SidebarResizer is rendered when sidebar is NOT collapsed
//   * SidebarResizer is hidden when sidebarCollapsed is true
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { AppShell } from '../../src/components/AppShell';
import { useStore } from '../../src/stores/store';
import { resetStore } from '../util/resetStore';

afterEach(() => cleanup());
beforeEach(() => resetStore());

describe('<AppShell />', () => {
  it('renders both sidebar and main slot content', () => {
    const { getByTestId } = render(
      <AppShell
        sidebar={<aside data-testid="sb">side</aside>}
        main={<main data-testid="mn">main</main>}
      />
    );
    expect(getByTestId('sb')).toBeInTheDocument();
    expect(getByTestId('mn')).toBeInTheDocument();
  });

  it('renders the resizer divider when sidebar is not collapsed', () => {
    act(() => useStore.setState({ sidebarCollapsed: false }));
    const { container } = render(
      <AppShell sidebar={<div />} main={<div />} />
    );
    // SidebarResizer renders a separator role with aria-orientation=vertical
    const sep = container.querySelector('[role="separator"]');
    expect(sep).not.toBeNull();
  });

  it('hides the resizer when sidebarCollapsed is true', () => {
    act(() => useStore.setState({ sidebarCollapsed: true }));
    const { container } = render(
      <AppShell sidebar={<div />} main={<div />} />
    );
    expect(container.querySelector('[role="separator"]')).toBeNull();
  });
});
