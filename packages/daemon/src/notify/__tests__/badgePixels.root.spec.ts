import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  renderBadgeImage,
  compositeTrayImage,
  fillCircle,
  drawLabel,
  RED,
  WHITE,
  TRANSPARENT,
  GLYPH_W,
  GLYPH_H,
  type BgraBitmap,
} from '../badgePixels.js';

const digest = (buf: Buffer): string =>
  createHash('sha256').update(buf).digest('hex').slice(0, 16);

// Build a deterministic 16x16 BGRA "base tray" bitmap: solid mid-grey, opaque.
function makeBaseBitmap(size = 16): BgraBitmap {
  const buffer = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const o = i * 4;
    buffer[o + 0] = 0x40; // B
    buffer[o + 1] = 0x40; // G
    buffer[o + 2] = 0x40; // R
    buffer[o + 3] = 0xff; // A
  }
  return { buffer, width: size, height: size };
}

describe('badgePixels.renderBadgeImage', () => {
  it('returns the requested square dimensions', () => {
    const img = renderBadgeImage('1', 16);
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
    expect(img.buffer.length).toBe(16 * 16 * 4);
  });

  it('produces a stable pixel checksum for label "1" @ 16px', () => {
    const img = renderBadgeImage('1', 16);
    expect(digest(img.buffer)).toMatchInlineSnapshot(`"3d0326f99c4af9ce"`);
  });

  it('produces a stable pixel checksum for label "9" @ 16px', () => {
    const img = renderBadgeImage('9', 16);
    expect(digest(img.buffer)).toMatchInlineSnapshot(`"65339562b6c79e49"`);
  });

  it('produces a stable pixel checksum for label "9+" @ 16px', () => {
    const img = renderBadgeImage('9+', 16);
    expect(digest(img.buffer)).toMatchInlineSnapshot(`"57d7dbf8edcd092b"`);
  });

  it('empty label still draws the red circle background', () => {
    const img = renderBadgeImage('', 16);
    // Center pixel must be RED (filled circle, no glyph overlay).
    const ci = (8 * 16 + 8) * 4;
    expect(img.buffer[ci + 0]).toBe(RED.r);
    expect(img.buffer[ci + 1]).toBe(RED.g);
    expect(img.buffer[ci + 2]).toBe(RED.b);
    expect(img.buffer[ci + 3]).toBe(RED.a);
    // Top-left pixel (corner) is outside the circle => transparent.
    expect(img.buffer[3]).toBe(TRANSPARENT.a);
  });

  it('different labels produce different pixels', () => {
    const a = digest(renderBadgeImage('1', 16).buffer);
    const b = digest(renderBadgeImage('9', 16).buffer);
    const c = digest(renderBadgeImage('9+', 16).buffer);
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('badgePixels.compositeTrayImage', () => {
  it('returns the requested square dimensions', () => {
    const img = compositeTrayImage(makeBaseBitmap(16), '9+', 16);
    expect(img.width).toBe(16);
    expect(img.height).toBe(16);
    expect(img.buffer.length).toBe(16 * 16 * 4);
  });

  it('produces a stable pixel checksum for "9+" overlay on grey base', () => {
    const img = compositeTrayImage(makeBaseBitmap(16), '9+', 16);
    expect(digest(img.buffer)).toMatchInlineSnapshot(`"e05874d349ee4892"`);
  });

  it('top-left pixel preserves the base (no badge in that corner)', () => {
    const img = compositeTrayImage(makeBaseBitmap(16), '1', 16);
    // Base is BGRA grey 0x40; output is RGBA, so R=G=B=0x40, A=0xff.
    expect(img.buffer[0]).toBe(0x40);
    expect(img.buffer[1]).toBe(0x40);
    expect(img.buffer[2]).toBe(0x40);
    expect(img.buffer[3]).toBe(0xff);
  });
});

describe('badgePixels.fillCircle / drawLabel primitives', () => {
  it('fillCircle fills the geometric centre with the requested colour', () => {
    const buf = Buffer.alloc(16 * 16 * 4);
    fillCircle(buf, 16, RED);
    const ci = (8 * 16 + 8) * 4;
    expect(buf[ci + 0]).toBe(RED.r);
    expect(buf[ci + 3]).toBe(RED.a);
  });

  it('drawLabel is a no-op for empty string', () => {
    const buf = Buffer.alloc(16 * 16 * 4);
    drawLabel(buf, 16, '', WHITE);
    // Buffer should remain all zeros.
    expect(buf.every((b) => b === 0)).toBe(true);
  });

  it('GLYPH_W and GLYPH_H describe the 3x5 font cell', () => {
    expect(GLYPH_W).toBe(3);
    expect(GLYPH_H).toBe(5);
  });
});
