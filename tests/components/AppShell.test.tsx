// UT for src/components/AppShell.tsx — the two-pane shell. Verifies:
//   * sidebar + main slots both render
//   * SidebarResizer is always rendered (sidebar collapse feature removed in #894)
import React from 'react';
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { AppShell } from '../../src/components/AppShell';
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

  it('always renders the resizer divider (collapse feature removed)', () => {
    const { container } = render(
      <AppShell sidebar={<div />} main={<div />} />
    );
    // SidebarResizer renders a separator role with aria-orientation=vertical
    const sep = container.querySelector('[role="separator"]');
    expect(sep).not.toBeNull();
  });
});
