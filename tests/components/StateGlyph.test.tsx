// UT for src/components/ui/StateGlyph.tsx — purely-decorative diamond
// SVG glyph used as a "waiting" inline marker. Coverage:
//   * sizes (xs/sm/md) map to the documented px contract
//   * decorative=true → aria-hidden, no role/label
//   * decorative=false (default) → role=img + aria-label=waiting
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
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${px} ${px}`);
  });

  it('default size is sm (10px)', () => {
    const { container } = render(<StateGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('width')).toBe('10');
  });

  it('default (decorative=false) exposes role=img + aria-label=waiting', () => {
    const { container } = render(<StateGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('role')).toBe('img');
    expect(svg.getAttribute('aria-label')).toBe('waiting');
    expect(svg.getAttribute('aria-hidden')).toBeNull();
  });

  it('decorative=true sets aria-hidden and omits role/label', () => {
    const { container } = render(<StateGlyph decorative />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.getAttribute('role')).toBeNull();
    expect(svg.getAttribute('aria-label')).toBeNull();
  });

  it('always carries the text-state-waiting base class', () => {
    const { container } = render(<StateGlyph />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toMatch(/text-state-waiting/);
  });

  it('forwards extra className', () => {
    const { container } = render(<StateGlyph className="my-token" />);
    const svg = container.querySelector('svg')!;
    expect(svg.getAttribute('class')).toMatch(/my-token/);
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
