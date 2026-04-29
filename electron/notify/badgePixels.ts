// Pure pixel rendering for the unread badge.
//
// This module is intentionally free of any `electron` import so it can be
// unit-tested in plain Node and so the pixel logic stays a pure
// (input -> bytes) sink. Callers in the Electron main process wrap the
// returned RGBA buffers via `nativeImage.createFromBuffer`.
//
// Output buffers are tightly packed RGBA (4 bytes per pixel, row-major,
// origin at top-left), suitable for `nativeImage.createFromBuffer({ width,
// height })`.
//
// Phase A of Task #722: this is a copy of the pixel helpers currently in
// `electron/notify/badge.ts`. badge.ts is unchanged in this PR; Phase B
// will switch the import and delete the originals.

export interface RgbaBitmap {
  buffer: Buffer;
  width: number;
  height: number;
}

export interface BgraBitmap {
  // Raw bitmap as returned by Electron's `NativeImage.toBitmap()`, which is
  // BGRA on every platform we ship. Caller is responsible for sizing.
  buffer: Buffer;
  width: number;
  height: number;
}

// 3x5 bitmap font for digits + '+'. Each glyph is 5 rows of 3 columns.
// 1 = ink, 0 = transparent.
export const GLYPHS: Record<string, number[][]> = {
  '0': [
    [1, 1, 1],
    [1, 0, 1],
    [1, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  '1': [
    [0, 1, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
    [1, 1, 1],
  ],
  '2': [
    [1, 1, 1],
    [0, 0, 1],
    [1, 1, 1],
    [1, 0, 0],
    [1, 1, 1],
  ],
  '3': [
    [1, 1, 1],
    [0, 0, 1],
    [0, 1, 1],
    [0, 0, 1],
    [1, 1, 1],
  ],
  '4': [
    [1, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 0, 1],
    [0, 0, 1],
  ],
  '5': [
    [1, 1, 1],
    [1, 0, 0],
    [1, 1, 1],
    [0, 0, 1],
    [1, 1, 1],
  ],
  '6': [
    [1, 1, 1],
    [1, 0, 0],
    [1, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  '7': [
    [1, 1, 1],
    [0, 0, 1],
    [0, 1, 0],
    [0, 1, 0],
    [0, 1, 0],
  ],
  '8': [
    [1, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
  ],
  '9': [
    [1, 1, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 0, 1],
    [1, 1, 1],
  ],
  '+': [
    [0, 0, 0],
    [0, 1, 0],
    [1, 1, 1],
    [0, 1, 0],
    [0, 0, 0],
  ],
};

export const GLYPH_W = 3;
export const GLYPH_H = 5;

export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

export const RED: Rgba = { r: 0xdc, g: 0x26, b: 0x26, a: 0xff };
export const WHITE: Rgba = { r: 0xff, g: 0xff, b: 0xff, a: 0xff };
export const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

// Renders an unread-badge as a square RGBA bitmap.
// Red filled circle background; white digit(s) centered on top.
export function renderBadgeImage(label: string, size: number): RgbaBitmap {
  const buf = Buffer.alloc(size * size * 4);
  fillCircle(buf, size, RED);
  drawLabel(buf, size, label, WHITE);
  return { buffer: buf, width: size, height: size };
}

// Composites the badge onto the bottom-right corner of a square base bitmap.
// `base` is taken as a raw BGRA bitmap (the format Electron's
// `NativeImage.toBitmap()` returns); the output is RGBA.
export function compositeTrayImage(
  base: BgraBitmap,
  label: string,
  size: number,
): RgbaBitmap {
  const baseBuf = base.buffer;
  const baseSize = { width: base.width, height: base.height };
  const buf = Buffer.alloc(size * size * 4);

  // Copy base (resize-fit if base isn't already the target size — simple
  // nearest-neighbour, since the placeholder base is 16x16 too).
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const sx = Math.floor((x * baseSize.width) / size);
      const sy = Math.floor((y * baseSize.height) / size);
      const si = (sy * baseSize.width + sx) * 4;
      const di = (y * size + x) * 4;
      // Electron's toBitmap is BGRA on every platform we care about.
      buf[di + 0] = baseBuf[si + 2]!;
      buf[di + 1] = baseBuf[si + 1]!;
      buf[di + 2] = baseBuf[si + 0]!;
      buf[di + 3] = baseBuf[si + 3]!;
    }
  }

  // Badge takes the bottom-right ~60% of the icon so digits stay readable.
  const badgeSize = Math.round(size * 0.62);
  const ox = size - badgeSize;
  const oy = size - badgeSize;
  const badge = Buffer.alloc(badgeSize * badgeSize * 4);
  fillCircle(badge, badgeSize, RED);
  drawLabel(badge, badgeSize, label, WHITE);
  blit(buf, size, badge, badgeSize, ox, oy);

  return { buffer: buf, width: size, height: size };
}

export function fillCircle(buf: Buffer, size: number, color: Rgba): void {
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const r = size / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      if (d <= r - 0.5) {
        buf[i + 0] = color.r;
        buf[i + 1] = color.g;
        buf[i + 2] = color.b;
        buf[i + 3] = color.a;
      } else if (d <= r + 0.5) {
        // Soft 1px edge for anti-alias.
        const t = Math.max(0, Math.min(1, r + 0.5 - d));
        buf[i + 0] = color.r;
        buf[i + 1] = color.g;
        buf[i + 2] = color.b;
        buf[i + 3] = Math.round(color.a * t);
      } else {
        buf[i + 0] = TRANSPARENT.r;
        buf[i + 1] = TRANSPARENT.g;
        buf[i + 2] = TRANSPARENT.b;
        buf[i + 3] = TRANSPARENT.a;
      }
    }
  }
}

// Lays out `label` characters horizontally, centered, scaled to fit ~70% of
// the canvas height. White ink only.
export function drawLabel(
  buf: Buffer,
  size: number,
  label: string,
  ink: Rgba,
): void {
  if (!label) return;
  const targetH = Math.max(5, Math.floor(size * 0.62));
  const scale = Math.max(1, Math.floor(targetH / GLYPH_H));
  const glyphW = GLYPH_W * scale;
  const glyphH = GLYPH_H * scale;
  const gap = scale; // 1 scaled pixel between glyphs
  const totalW = label.length * glyphW + (label.length - 1) * gap;
  const startX = Math.round((size - totalW) / 2);
  const startY = Math.round((size - glyphH) / 2);
  for (let ci = 0; ci < label.length; ci++) {
    const ch = label[ci]!;
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    const gx0 = startX + ci * (glyphW + gap);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!glyph[gy]![gx]) continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            const px = gx0 + gx * scale + sx;
            const py = startY + gy * scale + sy;
            if (px < 0 || px >= size || py < 0 || py >= size) continue;
            const i = (py * size + px) * 4;
            buf[i + 0] = ink.r;
            buf[i + 1] = ink.g;
            buf[i + 2] = ink.b;
            buf[i + 3] = ink.a;
          }
        }
      }
    }
  }
}

export function blit(
  dst: Buffer,
  dstSize: number,
  src: Buffer,
  srcSize: number,
  ox: number,
  oy: number,
): void {
  for (let y = 0; y < srcSize; y++) {
    for (let x = 0; x < srcSize; x++) {
      const si = (y * srcSize + x) * 4;
      const sa = src[si + 3]!;
      if (sa === 0) continue;
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dx >= dstSize || dy < 0 || dy >= dstSize) continue;
      const di = (dy * dstSize + dx) * 4;
      // Source-over alpha blend.
      const a = sa / 255;
      const inv = 1 - a;
      dst[di + 0] = Math.round(src[si + 0]! * a + dst[di + 0]! * inv);
      dst[di + 1] = Math.round(src[si + 1]! * a + dst[di + 1]! * inv);
      dst[di + 2] = Math.round(src[si + 2]! * a + dst[di + 2]! * inv);
      dst[di + 3] = Math.max(dst[di + 3]!, sa);
    }
  }
}
