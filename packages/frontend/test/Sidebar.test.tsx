import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Sidebar } from '../src/components/Sidebar';

describe('Sidebar', () => {
  let alertSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    alertSpy = vi.spyOn(window, 'alert').mockImplementation(() => {});
  });

  afterEach(() => {
    alertSpy.mockRestore();
    cleanup();
  });

  it('renders all six placeholder testids', () => {
    render(<Sidebar />);
    for (const id of [
      'sidebar-new-session',
      'sidebar-search',
      'sidebar-groups',
      'sidebar-archived',
      'sidebar-settings',
      'sidebar-import',
    ]) {
      expect(screen.getByTestId(id)).toBeDefined();
    }
  });

  it('shows the empty-state hint inside the GROUPS zone', () => {
    render(<Sidebar />);
    expect(
      screen.getByText(/No sessions yet — click \+ New Session above/),
    ).toBeDefined();
  });

  it('clicking each placeholder button does not crash and surfaces an alert', () => {
    render(<Sidebar />);
    fireEvent.click(screen.getByTestId('sidebar-new-session'));
    fireEvent.click(screen.getByTestId('sidebar-search'));
    fireEvent.click(screen.getByTestId('sidebar-settings'));
    fireEvent.click(screen.getByTestId('sidebar-import'));
    expect(alertSpy).toHaveBeenCalled();
  });

  it('toggles archived expanded state', () => {
    render(<Sidebar />);
    const toggle = screen.getByTestId('sidebar-archived');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText(/no archived groups/)).toBeDefined();
  });
});
