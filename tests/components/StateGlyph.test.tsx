// UT for src/components/ui/StateGlyph.tsx — purely-decorative diamond
// SVG glyph used as a "waiting" inline marker. Since Task 4 (desktop
// navigator adapter), StateGlyph delegates its rendering to the shared
// `SessionStateGlyph` (src/shared/sessionNavigator) — the accessible
// wrapper (role/aria-label/aria-hidden/data-state/className) now lives on
// the outer `<span>` that component renders, not on the inner `<svg>`
// itself. The public StateGlyph API (size/className/decorative) is
// unchanged. Coverage:
//   * sizes (xs/sm/md) map to the documented px contract on the <svg>
//   * viewBox stays the shared 12x12 grid regardless of size
//   * decorative=true → aria-hidden, no role/label (on the wrapper)
//   * decorative=false (default) → role=img + aria-label=waiting (wrapper)
//   * className passes through alongside base text-state-waiting class
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { StateGlyph } from '../../src/components/ui/StateGlyph';

afterEach(() => cleanup());

describe('<StateGlyph />', () => {
  it.each([
    ['xs', 8],
    ['sm', 10],
    ['md', 12],
  ] as const)('size=%s renders an SVG with width/height %ipx', (size, px) => {
    const { container } = render(<StateGlyph size={size} />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe(String(px));
    expect(svg.getAttribute('height')).toBe(String(px));
    // The shared glyph vocabulary always draws on a 12x12 grid and scales
    // via width/height — viewBox no longer tracks the requested pixel size.
    expect(svg.getAttribute('viewBox')).toBe('0 0 12 12');
  });

  it('default size is sm (10px)', () => {
    const { container } = render(<StateGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('10');
  });

  it('default (decorative=false) exposes role=img + aria-label=waiting on the wrapper', () => {
    const { container } = render(<StateGlyph />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('role')).toBe('img');
    expect(wrapper.getAttribute('aria-label')).toBe('waiting');
    expect(wrapper.getAttribute('aria-hidden')).toBeNull();
  });

  it('decorative=true sets aria-hidden and omits role/label on the wrapper', () => {
    const { container } = render(<StateGlyph decorative />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('aria-hidden')).toBe('true');
    expect(wrapper.getAttribute('role')).toBeNull();
    expect(wrapper.getAttribute('aria-label')).toBeNull();
  });

  it('always carries the text-state-waiting base class on the wrapper', () => {
    const { container } = render(<StateGlyph />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('class')).toMatch(/text-state-waiting/);
  });

  it('forwards extra className onto the wrapper', () => {
    const { container } = render(<StateGlyph className="my-token" />);
    const wrapper = container.firstElementChild!;
    expect(wrapper.getAttribute('class')).toMatch(/my-token/);
  });

  it('renders a single rotated rect (the diamond) inside the svg', () => {
    const { container } = render(<StateGlyph size="md" />);
    const rects = container.querySelectorAll('svg > rect');
    expect(rects.length).toBe(1);
    const rect = rects[0]!;
    expect(rect.getAttribute('transform')).toMatch(/rotate\(45/);
    expect(rect.getAttribute('fill')).toBe('currentColor');
  });
});
