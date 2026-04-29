import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useCwdPanelPosition } from '../../../src/components/cwd/useCwdPanelPosition';

function makeAnchor(rect: Partial<DOMRect>): HTMLElement {
  const el = document.createElement('div');
  // jsdom defaults getBoundingClientRect to all zeros; override.
  el.getBoundingClientRect = () =>
    ({
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      toJSON: () => ({}),
      ...rect,
    } as DOMRect);
  document.body.appendChild(el);
  return el;
}

describe('useCwdPanelPosition', () => {
  let originalInner: number;
  beforeEach(() => {
    originalInner = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1280,
    });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: originalInner,
    });
    document.body.innerHTML = '';
  });

  it('returns null while disabled', () => {
    const anchor = makeAnchor({ left: 100, bottom: 50 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, true, false));
    expect(result.current).toBeNull();
  });

  it('returns null while closed', () => {
    const anchor = makeAnchor({ left: 100, bottom: 50 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, false, true));
    expect(result.current).toBeNull();
  });

  it('positions below anchor with 4px gap, left-aligned to anchor', () => {
    const anchor = makeAnchor({ left: 100, bottom: 50 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, true, true));
    expect(result.current).toEqual({ top: 54, left: 100 });
  });

  it('clamps left so the panel never overflows the right viewport edge', () => {
    // viewport=1280, panel min-w 320, padding 8 -> maxLeft = 952
    const anchor = makeAnchor({ left: 1200, bottom: 30 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, true, true));
    expect(result.current).toEqual({ top: 34, left: 952 });
  });

  it('clamps left to padding when anchor is past the left viewport edge', () => {
    const anchor = makeAnchor({ left: -50, bottom: 20 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, true, true));
    expect(result.current).toEqual({ top: 24, left: 8 });
  });

  it('recomputes on window resize', () => {
    const anchor = makeAnchor({ left: 1200, bottom: 30 });
    const ref = { current: anchor } as React.RefObject<HTMLElement>;
    const { result } = renderHook(() => useCwdPanelPosition(ref, true, true));
    expect(result.current?.left).toBe(952);
    // Shrink viewport so maxLeft drops further.
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 800,
    });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    // maxLeft = 800 - 320 - 8 = 472
    expect(result.current?.left).toBe(472);
  });
});
