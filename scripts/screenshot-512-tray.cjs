// One-off visual capture for PR #512 — tray icon images.
//
// The tray icon is a 16x16 nativeImage handed to Electron's Tray API.
// Capturing a desktop screenshot of the system tray is brittle (icon
// position varies, system tray groups overflow) and the icon ends up
// being ~16 pixels in a sea of irrelevant chrome.
//
// Instead we render both the OLD placeholder buffer (flat white) and the
// NEW brand "C" buffer directly via the same code path that main.ts uses,
// then write the PNG bytes (via nativeImage.toPNG()) to disk. This is
// exactly what is handed to the OS tray, faithfully, with no screen
// capture noise. We also write a 16x scaled-up version so the design is
// actually visible on a screen.
//
// Run via: npx electron scripts/screenshot-512-tray.cjs

const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { app, nativeImage } = require('electron');

const OUT_DIR = path.resolve(__dirname, '..', 'docs', 'screenshots', '512-padding-tray');
mkdirSync(OUT_DIR, { recursive: true });

// === BEFORE: the old placeholder. Reconstructed verbatim from the
// pre-PR code: a 16x16 RGBA buffer set to opaque white pixels.
function buildOldTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    buf[i * 4 + 0] = 0xff;
    buf[i * 4 + 1] = 0xff;
    buf[i * 4 + 2] = 0xff;
    buf[i * 4 + 3] = 0xff;
  }
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// === AFTER: copy of buildTrayIcon() in electron/main.ts (PR #512).
function buildNewTrayIcon() {
  const size = 16;
  const buf = Buffer.alloc(size * size * 4);
  const FG_R = 0xe0, FG_G = 0x7a, FG_B = 0x3f;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size / 2;
  const rInner = rOuter - 3;
  const arcGapHalf = 2.2;
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
      if (d <= rOuter - 0.25 && d >= rInner) {
        const inGap = dx > 0 && Math.abs(dy) <= arcGapHalf;
        if (inGap) continue;
        let alpha = 255;
        if (d > rOuter - 1.25) {
          const t = Math.max(0, Math.min(1, (rOuter - 0.25) - d));
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

// Render an icon onto a checker background at scale=1 and scale=16, save
// PNGs. Two backgrounds: light (Windows light tray) and dark (Windows dark
// tray) so reviewers can see contrast.
function saveOnBackground(icon, label, bgRgb) {
  const size = 16;
  const scale = 16; // 256x256 final
  const bgSize = size * scale;
  const out = Buffer.alloc(bgSize * bgSize * 4);
  // Fill background.
  for (let i = 0; i < bgSize * bgSize; i++) {
    out[i * 4 + 0] = bgRgb[0];
    out[i * 4 + 1] = bgRgb[1];
    out[i * 4 + 2] = bgRgb[2];
    out[i * 4 + 3] = 0xff;
  }
  // Composite icon (nearest-neighbor scale by `scale`).
  const iconBuf = icon.toBitmap();
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const si = (y * size + x) * 4;
      // toBitmap returns BGRA on Windows. Swap.
      const b = iconBuf[si + 0];
      const g = iconBuf[si + 1];
      const r = iconBuf[si + 2];
      const a = iconBuf[si + 3];
      if (a === 0) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const px = x * scale + dx;
          const py = y * scale + dy;
          const di = (py * bgSize + px) * 4;
          // Alpha-composite over bg.
          const af = a / 255;
          out[di + 0] = Math.round(r * af + bgRgb[0] * (1 - af));
          out[di + 1] = Math.round(g * af + bgRgb[1] * (1 - af));
          out[di + 2] = Math.round(b * af + bgRgb[2] * (1 - af));
          out[di + 3] = 0xff;
        }
      }
    }
  }
  const composite = nativeImage.createFromBuffer(out, { width: bgSize, height: bgSize });
  const outPath = path.join(OUT_DIR, `${label}.png`);
  writeFileSync(outPath, composite.toPNG());
  console.log(`saved ${outPath}`);
}

// Also save the 1x raw PNG for archival/compare.
function saveRaw(icon, label) {
  const outPath = path.join(OUT_DIR, `${label}-1x.png`);
  writeFileSync(outPath, icon.toPNG());
  console.log(`saved ${outPath}`);
}

app.whenReady().then(() => {
  const before = buildOldTrayIcon();
  const after = buildNewTrayIcon();

  saveRaw(before, 'before-tray');
  saveRaw(after, 'after-tray');

  // Two background colors representative of Windows tray:
  //  - dark: #202020-ish (default dark taskbar)
  //  - light: #f3f3f3-ish (light taskbar)
  saveOnBackground(before, 'before-tray-on-dark', [0x20, 0x20, 0x20]);
  saveOnBackground(before, 'before-tray-on-light', [0xf3, 0xf3, 0xf3]);
  saveOnBackground(after, 'after-tray-on-dark', [0x20, 0x20, 0x20]);
  saveOnBackground(after, 'after-tray-on-light', [0xf3, 0xf3, 0xf3]);

  app.quit();
});
