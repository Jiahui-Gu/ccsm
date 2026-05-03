import { describe, it, expect } from 'vitest';
import {
  GLYPHS,
  GLYPH_W,
  GLYPH_H,
  RED,
  WHITE,
  TRANSPARENT,
  blit,
  compositeTrayImage,
  drawLabel,
  fillCircle,
  renderBadgeImage,
  type BgraBitmap,
} from '../badgePixels.js';

// Pure pixel renderer — tests assert real RGBA bytes, not mocks.
// Buffer layout: row-major, 4 bytes/pixel (R,G,B,A), origin top-left.
function px(buf: Buffer, size: number, x: number, y: number) {
  const i = (y * size + x) * 4;
  return { r: buf[i]!, g: buf[i + 1]!, b: buf[i + 2]!, a: buf[i + 3]! };
}

describe('badgePixels constants', () => {
  it('GLYPHS has every digit 0-9 and the plus sign as 5x3 bitmaps', () => {
    for (const ch of '0123456789+') {
      const g = GLYPHS[ch];
      expect(g, `glyph ${ch}`).toBeDefined();
      expect(g!.length).toBe(GLYPH_H);
      for (const row of g!) expect(row.length).toBe(GLYPH_W);
    }
  });

  it('color constants are opaque red / opaque white / fully transparent', () => {
    expect(RED.a).toBe(0xff);
    expect(WHITE).toEqual({ r: 0xff, g: 0xff, b: 0xff, a: 0xff });
    expect(TRANSPARENT).toEqual({ r: 0, g: 0, b: 0, a: 0 });
  });
});

describe('fillCircle', () => {
  it('writes opaque color at the center and transparent at the corners', () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    fillCircle(buf, size, RED);
    const c = px(buf, size, 8, 8);
    expect(c.r).toBe(RED.r);
    expect(c.g).toBe(RED.g);
    expect(c.b).toBe(RED.b);
    expect(c.a).toBe(0xff);
    // Top-left corner is well outside the inscribed circle.
    expect(px(buf, size, 0, 0).a).toBe(0);
    expect(px(buf, size, size - 1, 0).a).toBe(0);
    expect(px(buf, size, 0, size - 1).a).toBe(0);
    expect(px(buf, size, size - 1, size - 1).a).toBe(0);
  });
});

describe('renderBadgeImage', () => {
  it('returns a square buffer of size*size*4 bytes', () => {
    const out = renderBadgeImage('1', 16);
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    expect(out.buffer.length).toBe(16 * 16 * 4);
  });

  it("draws white ink for the label '9' on top of a red circle", () => {
    const out = renderBadgeImage('9', 24);
    let whitePixels = 0;
    let redPixels = 0;
    for (let i = 0; i < out.buffer.length; i += 4) {
      const r = out.buffer[i]!;
      const g = out.buffer[i + 1]!;
      const b = out.buffer[i + 2]!;
      const a = out.buffer[i + 3]!;
      if (a !== 0xff) continue;
      if (r === 0xff && g === 0xff && b === 0xff) whitePixels++;
      else if (r === RED.r && g === RED.g && b === RED.b) redPixels++;
    }
    // The "9" glyph at scale ≥1 inside a 24px circle must produce some
    // real white pixels and a substantial red background.
    expect(whitePixels).toBeGreaterThan(0);
    expect(redPixels).toBeGreaterThan(whitePixels);
  });

  it("empty label leaves the circle pure red (no ink pixels)", () => {
    const out = renderBadgeImage('', 16);
    let whitePixels = 0;
    for (let i = 0; i < out.buffer.length; i += 4) {
      if (
        out.buffer[i] === 0xff &&
        out.buffer[i + 1] === 0xff &&
        out.buffer[i + 2] === 0xff &&
        out.buffer[i + 3] === 0xff
      ) {
        whitePixels++;
      }
    }
    expect(whitePixels).toBe(0);
  });
});

describe('drawLabel', () => {
  it("skips characters not in the GLYPHS table without throwing", () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    // 'Z' isn't in the glyph table.
    drawLabel(buf, size, 'Z', WHITE);
    // Buffer remains zeroed (no ink drawn).
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });

  it("draws nothing for an empty label", () => {
    const size = 16;
    const buf = Buffer.alloc(size * size * 4);
    drawLabel(buf, size, '', WHITE);
    expect(buf.every((byte) => byte === 0)).toBe(true);
  });
});

describe('compositeTrayImage', () => {
  it('converts the BGRA base to RGBA and overlays a red badge in the bottom-right corner', () => {
    // Build a 16x16 BGRA base filled with opaque blue (B=0xFF, G=0, R=0).
    const baseSize = 16;
    const base: BgraBitmap = {
      buffer: Buffer.alloc(baseSize * baseSize * 4),
      width: baseSize,
      height: baseSize,
    };
    for (let i = 0; i < base.buffer.length; i += 4) {
      base.buffer[i] = 0xff; // B
      base.buffer[i + 1] = 0;
      base.buffer[i + 2] = 0;
      base.buffer[i + 3] = 0xff; // A
    }
    const out = compositeTrayImage(base, '1', 16);
    expect(out.width).toBe(16);
    expect(out.height).toBe(16);
    // Top-left corner stays the base color, swapped to RGBA: (0,0,0xFF,0xFF).
    const tl = px(out.buffer, 16, 0, 0);
    expect(tl).toEqual({ r: 0, g: 0, b: 0xff, a: 0xff });
    // Bottom-right corner falls under the badge; it must include some red
    // pixels from the badge circle.
    let redInBadge = 0;
    for (let y = 8; y < 16; y++) {
      for (let x = 8; x < 16; x++) {
        const p = px(out.buffer, 16, x, y);
        if (p.r > 0x80 && p.b < 0x80 && p.a === 0xff) redInBadge++;
      }
    }
    expect(redInBadge).toBeGreaterThan(0);
  });
});

describe('blit', () => {
  it('skips fully transparent source pixels (no destination overwrite)', () => {
    const dstSize = 8;
    const dst = Buffer.alloc(dstSize * dstSize * 4);
    // Pre-fill destination with opaque green.
    for (let i = 0; i < dst.length; i += 4) {
      dst[i + 1] = 0xff;
      dst[i + 3] = 0xff;
    }
    const srcSize = 4;
    const src = Buffer.alloc(srcSize * srcSize * 4); // all-transparent
    blit(dst, dstSize, src, srcSize, 0, 0);
    // Destination unchanged everywhere.
    for (let i = 0; i < dst.length; i += 4) {
      expect(dst[i + 1]).toBe(0xff);
      expect(dst[i + 3]).toBe(0xff);
    }
  });

  it('alpha-blends opaque source over destination at the offset', () => {
    const dstSize = 4;
    const dst = Buffer.alloc(dstSize * dstSize * 4);
    // dst opaque blue.
    for (let i = 0; i < dst.length; i += 4) {
      dst[i + 2] = 0xff;
      dst[i + 3] = 0xff;
    }
    const srcSize = 2;
    const src = Buffer.alloc(srcSize * srcSize * 4);
    // src opaque red.
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 0xff;
      src[i + 3] = 0xff;
    }
    blit(dst, dstSize, src, srcSize, 1, 1);
    // Position (0,0) untouched (stays blue).
    expect(px(dst, dstSize, 0, 0)).toEqual({ r: 0, g: 0, b: 0xff, a: 0xff });
    // Position (1,1) overwritten to red.
    expect(px(dst, dstSize, 1, 1)).toEqual({ r: 0xff, g: 0, b: 0, a: 0xff });
  });

  it('clips writes that would land outside the destination', () => {
    const dstSize = 4;
    const dst = Buffer.alloc(dstSize * dstSize * 4);
    const srcSize = 4;
    const src = Buffer.alloc(srcSize * srcSize * 4);
    for (let i = 0; i < src.length; i += 4) {
      src[i] = 0xff;
      src[i + 3] = 0xff;
    }
    // Offset entirely off-canvas — must not throw or corrupt dst.
    blit(dst, dstSize, src, srcSize, 100, 100);
    expect(dst.every((b) => b === 0)).toBe(true);
  });
});
