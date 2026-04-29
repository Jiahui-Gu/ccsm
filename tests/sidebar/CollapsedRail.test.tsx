// RTL coverage for <CollapsedRail /> — the 48px-wide rail that replaces the
// expanded sidebar when the user collapses it. It hosts the same six action
// affordances (toggle / new session / search / spacer / import / settings)
// and is pure layout: every click is a passthrough to a parent callback.
//
// This file asserts (a) all five icon buttons are rendered with translated
// aria-labels, (b) each click reaches its callback, and (c) the macOS vs
// Windows/Linux platform branch toggles the top padding class (room for the
// stoplights on darwin).
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { CollapsedRail } from '../../src/components/sidebar/CollapsedRail';

type Platform = 'darwin' | 'win32' | 'linux';

function stubPlatform(platform: Platform) {
  (globalThis as unknown as {
    window: Window & { ccsm?: unknown };
  }).window.ccsm = { window: { platform } };
}

describe('<CollapsedRail />', () => {
  beforeEach(() => {
    stubPlatform('linux');
  });

  afterEach(() => {
    cleanup();
    delete (window as unknown as { ccsm?: unknown }).ccsm;
  });

  it('renders all five action buttons with translated aria-labels and tooltips', () => {
    const { getByRole, container } = render(
      <CollapsedRail
        onToggleSidebar={() => {}}
        onCreateSession={() => {}}
        onOpenPalette={() => {}}
        onOpenImport={() => {}}
        onOpenSettings={() => {}}
      />
    );

    // The rail uses real translation keys; en.ts provides these aria labels.
    expect(getByRole('button', { name: /expand sidebar/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /new session/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /search/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /import/i })).toBeInTheDocument();
    expect(getByRole('button', { name: /settings/i })).toBeInTheDocument();

    // 5 IconButtons total → 5 <button> nodes.
    expect(container.querySelectorAll('button').length).toBe(5);
  });

  it('routes each click to the matching callback', () => {
    const onToggleSidebar = vi.fn();
    const onCreateSession = vi.fn();
    const onOpenPalette = vi.fn();
    const onOpenImport = vi.fn();
    const onOpenSettings = vi.fn();
    const { getByRole } = render(
      <CollapsedRail
        onToggleSidebar={onToggleSidebar}
        onCreateSession={onCreateSession}
        onOpenPalette={onOpenPalette}
        onOpenImport={onOpenImport}
        onOpenSettings={onOpenSettings}
      />
    );

    fireEvent.click(getByRole('button', { name: /expand sidebar/i }));
    fireEvent.click(getByRole('button', { name: /new session/i }));
    fireEvent.click(getByRole('button', { name: /search/i }));
    fireEvent.click(getByRole('button', { name: /import/i }));
    fireEvent.click(getByRole('button', { name: /settings/i }));

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);
    expect(onCreateSession).toHaveBeenCalledTimes(1);
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    expect(onOpenImport).toHaveBeenCalledTimes(1);
    expect(onOpenSettings).toHaveBeenCalledTimes(1);
  });

  it('does not throw if the optional click handlers are omitted', () => {
    const { getByRole } = render(<CollapsedRail onToggleSidebar={() => {}} />);
    // Each optional handler is wrapped in an arrow, so a click should be a no-op.
    expect(() =>
      fireEvent.click(getByRole('button', { name: /new session/i }))
    ).not.toThrow();
    expect(() =>
      fireEvent.click(getByRole('button', { name: /search/i }))
    ).not.toThrow();
    expect(() =>
      fireEvent.click(getByRole('button', { name: /import/i }))
    ).not.toThrow();
    expect(() =>
      fireEvent.click(getByRole('button', { name: /settings/i }))
    ).not.toThrow();
  });

  it('uses tighter py-1 padding on darwin (room for stoplights)', () => {
    stubPlatform('darwin');
    const { container } = render(<CollapsedRail onToggleSidebar={() => {}} />);
    const rail = container.firstElementChild as HTMLElement;
    expect(rail.className).toContain('py-1');
    expect(rail.className).not.toContain('py-3');
  });

  it('uses standard py-3 padding on non-darwin platforms', () => {
    stubPlatform('win32');
    const { container } = render(<CollapsedRail onToggleSidebar={() => {}} />);
    const rail = container.firstElementChild as HTMLElement;
    expect(rail.className).toContain('py-3');
    expect(rail.className).not.toContain('py-1');
  });
});
