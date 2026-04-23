#!/usr/bin/env node
// Generate build/icon.png — a simple 1024x1024 solid-background app icon
// with a large letter "A" centered. Pure-node (no image libs) so CI can
// regenerate deterministically without extra deps.
//
// Run:  node scripts/generate-app-icon.mjs
// Output: build/icon.png
//
// Layout: dark blue-grey background (#1E293B), cream "A" glyph drawn as
// a mask: two slanted legs + a crossbar. No antialiasing — a pixel is
// either background or foreground. electron-builder picks this up via
// `build.directories.buildResources = "build"` and uses it as the
// win/mac/linux icon source (converted to .ico / .icns internally).

import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { deflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const SIZE = 1024;
const BG = [0x1e, 0x29, 0x3b, 0xff]; // slate-800
const FG = [0xfd, 0xf6, 0xe3, 0xff]; // cream

// Build RGBA pixel buffer with PNG row filter prefix (0 = None).
const row = SIZE * 4;
const raw = Buffer.alloc((row + 1) * SIZE);
for (let y = 0; y < SIZE; y++) {
  raw[y * (row + 1)] = 0; // filter byte
  for (let x = 0; x < SIZE; x++) {
    const off = y * (row + 1) + 1 + x * 4;
    raw[off] = BG[0];
    raw[off + 1] = BG[1];
    raw[off + 2] = BG[2];
    raw[off + 3] = BG[3];
  }
}

// Draw the letter "A" — two slanted strokes from baseline to apex plus a
// horizontal crossbar. Implemented as signed-distance checks: each pixel
// asks whether it lies within `thickness/2` of each stroke line.
const thickness = 96;
const apex = { x: SIZE / 2, y: 190 };
const left = { x: 260, y: 860 };
const right = { x: SIZE - 260, y: 860 };
const crossbarY = 640;
const half = thickness / 2;

function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  const ex = px - cx;
  const ey = py - cy;
  return Math.sqrt(ex * ex + ey * ey);
}

function insideGlyph(x, y) {
  if (distToSegment(x, y, apex.x, apex.y, left.x, left.y) < half) return true;
  if (distToSegment(x, y, apex.x, apex.y, right.x, right.y) < half) return true;
  // Crossbar: horizontal line between the two legs at crossbarY, respecting
  // the glyph width at that y so the bar doesn't overshoot.
  if (Math.abs(y - crossbarY) < half * 0.6) {
    const frac = (crossbarY - apex.y) / (left.y - apex.y);
    const lx = apex.x + frac * (left.x - apex.x) + half * 0.6;
    const rx = apex.x + frac * (right.x - apex.x) - half * 0.6;
    if (x >= lx && x <= rx) return true;
  }
  return false;
}

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    if (insideGlyph(x, y)) {
      const off = y * (row + 1) + 1 + x * 4;
      raw[off] = FG[0];
      raw[off + 1] = FG[1];
      raw[off + 2] = FG[2];
      raw[off + 3] = FG[3];
    }
  }
}

// PNG encoder — minimal: IHDR (8-bit RGBA) + single IDAT (deflate) + IEND.
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type: RGBA
ihdr[10] = 0; // compression
ihdr[11] = 0; // filter
ihdr[12] = 0; // interlace
const idat = deflateSync(raw, { level: 9 });
const iend = Buffer.alloc(0);

const png = Buffer.concat([
  signature,
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', iend),
]);

const here = dirname(fileURLToPath(import.meta.url));
const outPath = resolve(here, '..', 'build', 'icon.png');
await mkdir(dirname(outPath), { recursive: true });
await new Promise((res, rej) => {
  const ws = createWriteStream(outPath);
  ws.on('error', rej);
  ws.on('finish', res);
  ws.end(png);
});
// eslint-disable-next-line no-console
console.log(`wrote ${outPath} (${png.length} bytes, ${SIZE}x${SIZE})`);
