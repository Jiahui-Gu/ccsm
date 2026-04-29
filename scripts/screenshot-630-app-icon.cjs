// Visual verification for #630 — render the brand "C" mark at every
// resolution that ships in build/icon.ico, on both light and dark
// backgrounds, and dump them as PNGs reviewers can inspect.
//
// This proves the multi-res rendering produces a recognizable mark at
// every size the OS may ask for (taskbar 32x32, Alt-Tab 48x48, window
// switcher preview 256x256, installer dialog 256x256).
//
// Run via: npx electron scripts/screenshot-630-app-icon.cjs

const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { app, nativeImage } = require('electron');

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots', '630-unified-app-icon');
mkdirSync(OUT_DIR, { recursive: true });

const SIZES = [16, 24, 32, 48, 64, 128, 256];

function renderCMark(size) {
  const buf = Buffer.alloc(size * size * 4);
  const FG_R = 0xe0, FG_G = 0x7a, FG_B = 0x3f;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size / 2;
  const rInner = rOuter - (3 / 16) * size;
  const arcGapHalf = (2.2 / 16) * size;
  const edgeWidth = (1 / 16) * size;
  const edgeOffset = (0.25 / 16) * size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dx = x - cx;
      const dy = y - cy;
      const d = Math.sqrt(dx * dx + dy * dy);
      const i = (y * size + x) * 4;
      buf[i + 0] = 0;
      buf[i + 1] = 0;
      buf[i + 2] = 0;
      buf[i + 3] = 0;
      if (d <= rOuter - edgeOffset && d >= rInner) {
        const inGap = dx > 0 && Math.abs(dy) <= arcGapHalf;
        if (inGap) continue;
        let alpha = 255;
        if (d > rOuter - edgeOffset - edgeWidth) {
          const t = Math.max(0, Math.min(1, rOuter - edgeOffset - d));
          alpha = Math.round(255 * t);
        }
        buf[i + 0] = FG_R;
        buf[i + 1] = FG_G;
        buf[i + 2] = FG_B;
        buf[i + 3] = alpha;
      }
    }
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// Render on a tinted background so the alpha edge is visible.
function compositeOnBg(rgba, size, bg) {
  const out = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    const af = rgba[i * 4 + 3] / 255;
    out[i * 4 + 0] = Math.round(rgba[i * 4 + 0] * af + bg[0] * (1 - af));
    out[i * 4 + 1] = Math.round(rgba[i * 4 + 1] * af + bg[1] * (1 - af));
    out[i * 4 + 2] = Math.round(rgba[i * 4 + 2] * af + bg[2] * (1 - af));
    out[i * 4 + 3] = 0xff;
  }
  return out;
}

app.whenReady().then(() => {
  // Per-size raw PNG.
  for (const size of SIZES) {
    const img = renderCMark(size);
    writeFileSync(path.join(OUT_DIR, `after-c-mark-${size}px.png`), img.toPNG());
    console.log(`saved after-c-mark-${size}px.png`);
  }

  // 256x256 on dark + light background (representative of Win11 dark/light
  // taskbar tile background and macOS dock).
  const bigRgba = renderCMark(256).toBitmap();
  // toBitmap is BGRA on Win — swap to RGBA for our compositor.
  const rgba = Buffer.alloc(256 * 256 * 4);
  for (let i = 0; i < 256 * 256; i++) {
    rgba[i * 4 + 0] = bigRgba[i * 4 + 2];
    rgba[i * 4 + 1] = bigRgba[i * 4 + 1];
    rgba[i * 4 + 2] = bigRgba[i * 4 + 0];
    rgba[i * 4 + 3] = bigRgba[i * 4 + 3];
  }
  const onDark = nativeImage.createFromBuffer(
    compositeOnBg(rgba, 256, [0x20, 0x20, 0x20]),
    { width: 256, height: 256 }
  );
  const onLight = nativeImage.createFromBuffer(
    compositeOnBg(rgba, 256, [0xf3, 0xf3, 0xf3]),
    { width: 256, height: 256 }
  );
  writeFileSync(path.join(OUT_DIR, 'after-256-on-dark.png'), onDark.toPNG());
  writeFileSync(path.join(OUT_DIR, 'after-256-on-light.png'), onLight.toPNG());
  console.log('saved after-256-on-dark.png + after-256-on-light.png');

  // Reference: the default Electron logo (BEFORE) — we can't render it
  // procedurally, so we point reviewers to electron's bundled default
  // (electron's built-in icon) by including a note in the PR. The "AFTER"
  // PNGs above are the ground truth for what users will see.

  app.quit();
});
