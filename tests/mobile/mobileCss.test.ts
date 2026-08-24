import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

describe('mobile mirror frame CSS', () => {
  it('preserves intrinsic aspect ratio so the painted image fills its box', () => {
    const css = readFileSync(path.resolve('src/mobile/mobile.css'), 'utf8');
    const rule = css.match(/#mirror-frame\s*\{([^}]*)\}/)?.[1] ?? '';

    // With only max-width/max-height + object-fit: contain, Chromium can size
    // the replaced element's box using the frame's width/height attributes
    // (e.g. 1152x648) rather than the space actually available, letterboxing
    // the painted image inside an oversized box. That desyncs
    // getBoundingClientRect() from the visible pixels, so normalized tap
    // coordinates land off-target. `width: auto; height: auto` forces the box
    // to shrink to the constrained, ratio-preserving size instead.
    expect(rule).toMatch(/width:\s*auto\s*;/);
    expect(rule).toMatch(/height:\s*auto\s*;/);
  });
});
