// Unit tests for SidebarResizer keyboard accessibility (#263).
//
// Covers tab-reachability + arrow-key resize + Home/End snap. Mouse drag
// behavior is unchanged and not retested here — it was already covered by
// implicit dogfood and the pointer handlers are untouched. Visual focus ring
// is verified via the before/after screenshots in dogfood-logs/.
import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { SidebarResizer, SIDEBAR_RESIZER_STEP, SIDEBAR_RESIZER_STEP_LARGE } from '../src/components/SidebarResizer';
import { useStore } from '../src/stores/store';
import { SIDEBAR_WIDTH_DEFAULT, SIDEBAR_WIDTH_MIN, SIDEBAR_WIDTH_MAX } from '../src/stores/slices/appearanceSlice';

describe('SidebarResizer keyboard a11y', () => {
  beforeEach(() => {
    useStore.setState({ sidebarWidth: SIDEBAR_WIDTH_DEFAULT });
  });
  afterEach(() => cleanup());

  it('renders as a focusable separator with aria attributes', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator', { name: 'Resize sidebar' });
    expect(sep.getAttribute('tabindex')).toBe('0');
    expect(sep.getAttribute('aria-orientation')).toBe('vertical');
    expect(sep.getAttribute('aria-valuemin')).toBe(String(SIDEBAR_WIDTH_MIN));
    expect(sep.getAttribute('aria-valuemax')).toBe(String(SIDEBAR_WIDTH_MAX));
    expect(sep.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_WIDTH_DEFAULT));
  });

  it('ArrowRight increases width by one step', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_RESIZER_STEP);
  });

  it('ArrowLeft decreases width by one step', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT - SIDEBAR_RESIZER_STEP);
  });

  it('Shift+ArrowRight uses the larger step', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowRight', shiftKey: true });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT + SIDEBAR_RESIZER_STEP_LARGE);
  });

  it('Shift+ArrowLeft uses the larger step', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowLeft', shiftKey: true });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT - SIDEBAR_RESIZER_STEP_LARGE);
  });

  it('Home snaps to min width', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'Home' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it('End snaps to max width', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('clamps to min when ArrowLeft would go below SIDEBAR_WIDTH_MIN', () => {
    useStore.setState({ sidebarWidth: SIDEBAR_WIDTH_MIN });
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MIN);
  });

  it('clamps to max when ArrowRight would exceed SIDEBAR_WIDTH_MAX', () => {
    useStore.setState({ sidebarWidth: SIDEBAR_WIDTH_MAX });
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_MAX);
  });

  it('Escape blurs the handle', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    expect(document.activeElement).toBe(sep);
    fireEvent.keyDown(sep, { key: 'Escape' });
    expect(document.activeElement).not.toBe(sep);
  });

  it('Enter blurs the handle', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    expect(document.activeElement).toBe(sep);
    fireEvent.keyDown(sep, { key: 'Enter' });
    expect(document.activeElement).not.toBe(sep);
  });

  it('aria-valuenow updates to reflect the new width', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'End' });
    expect(sep.getAttribute('aria-valuenow')).toBe(String(SIDEBAR_WIDTH_MAX));
  });

  it('ignores unrelated keys', () => {
    render(<SidebarResizer />);
    const sep = screen.getByRole('separator');
    sep.focus();
    fireEvent.keyDown(sep, { key: 'a' });
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_WIDTH_DEFAULT);
  });
});
