// Generate build/icon.ico and build/icon.png from the same procedural "C"
// mark used by the tray icon (electron/main.ts buildTrayIcon, PR #512).
//
// Why a script + committed asset: BrowserWindow.icon for the taskbar icon and
// electron-builder's installer icon need a real .ico file on disk at build
// time. The tray icon already renders at runtime via nativeImage.createFromBuffer,
// but that approach can't be fed to electron-builder's NSIS step which reads
// the icon from a path string in package.json["build"]. So we render the same
// design at multiple resolutions, pack the PNG bytes into a Vista+ PNG-payload
// ICO, and commit the resulting binary so CI builds don't need any extra
// tooling.
//
// The script is regeneratable: re-run any time the brand mark changes.
//   npx electron scripts/build-icon.cjs
//
// Output:
//   build/icon.ico  — multi-res Windows icon (16/24/32/48/64/128/256), Vista+ PNG entries
//   build/icon.png  — 1024x1024 PNG, used by electron-builder for Linux + macOS
//                     targets. macOS dmg packaging requires the source image to
//                     be at least 512x512; we ship 1024 so iconset generation
//                     has plenty of headroom.
//
// The render function is intentionally duplicated from electron/main.ts
// buildTrayIcon (and from scripts/screenshot-512-tray.cjs). Three callers, one
// design — when the brand mark changes, update all three. Procedural pixels
// keep the brand asset binary-free for review (the .ico is just a packaging
// convenience).

const path = require('node:path');
const { mkdirSync, writeFileSync } = require('node:fs');
const { app, nativeImage } = require('electron');

const OUT_DIR = path.resolve(__dirname, '..', 'build');
// Sizes packed into the multi-res Windows .ico. 256 is the max the legacy ICO
// header can address (it encodes 256 as 0 in the 1-byte width field). The
// standalone build/icon.png is generated separately at PNG_SIZE below for
// Linux + macOS targets, where electron-builder needs a higher-resolution
// source than 256x256.
const SIZES = [16, 24, 32, 48, 64, 128, 256];
// Source resolution for the standalone build/icon.png. macOS dmg packaging
// rejects anything below 512x512; 1024 gives the iconset generator headroom.
const PNG_SIZE = 1024;

// Render the "C" mark at an arbitrary square size. Constants are scaled from
// the original 16x16 design (rInner = rOuter - 3, arcGapHalf = 2.2) so the
// 256x256 version is visually identical to the 16x16 tray icon.
function renderCMark(size) {
  const buf = Buffer.alloc(size * size * 4);
  const FG_R = 0xe0, FG_G = 0x7a, FG_B = 0x3f;
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const rOuter = size / 2;
  const rInner = rOuter - (3 / 16) * size;
  const arcGapHalf = (2.2 / 16) * size;
  // AA edge width also scales with size (was 1px at size=16).
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
          const t = Math.max(0, Math.min(1, (rOuter - edgeOffset) - d));
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

// Pack PNG payloads into a Vista+ ICO file. Each ICONDIRENTRY points at a PNG
// blob (BITMAPINFOHEADER format would also work but PNG is shorter for the
// 256x256 entry and supported on all targets >= Vista, which is the electron
// minimum already).
function packIco(entries) {
  // entries: [{ size: number, png: Buffer }]
  const ICONDIR_LEN = 6;
  const ICONDIRENTRY_LEN = 16;
  const headerLen = ICONDIR_LEN + entries.length * ICONDIRENTRY_LEN;
  const totalLen = headerLen + entries.reduce((acc, e) => acc + e.png.length, 0);
  const out = Buffer.alloc(totalLen);

  // ICONDIR
  out.writeUInt16LE(0, 0);            // reserved
  out.writeUInt16LE(1, 2);            // type = 1 (icon)
  out.writeUInt16LE(entries.length, 4);

  let dataOffset = headerLen;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const off = ICONDIR_LEN + i * ICONDIRENTRY_LEN;
    // Width / height: 0 means 256.
    out.writeUInt8(e.size === 256 ? 0 : e.size, off + 0);
    out.writeUInt8(e.size === 256 ? 0 : e.size, off + 1);
    out.writeUInt8(0, off + 2);       // color count (0 for >= 8bpp)
    out.writeUInt8(0, off + 3);       // reserved
    out.writeUInt16LE(1, off + 4);    // color planes
    out.writeUInt16LE(32, off + 6);   // bits per pixel
    out.writeUInt32LE(e.png.length, off + 8);
    out.writeUInt32LE(dataOffset, off + 12);
    e.png.copy(out, dataOffset);
    dataOffset += e.png.length;
  }
  return out;
}

app.whenReady().then(() => {
  mkdirSync(OUT_DIR, { recursive: true });

  const entries = SIZES.map((size) => ({
    size,
    png: renderCMark(size).toPNG()
  }));

  const ico = packIco(entries);
  const icoPath = path.join(OUT_DIR, 'icon.ico');
  writeFileSync(icoPath, ico);
  console.log(`wrote ${icoPath} (${ico.length} bytes, ${entries.length} resolutions: ${SIZES.join('/')})`);

  // High-res PNG for Linux + macOS (and as a generic fallback). electron-builder
  // synthesizes per-target sizes from this one source; macOS dmg packaging
  // requires >= 512x512 so we render fresh at PNG_SIZE rather than reusing the
  // 256x256 entry from the .ico.
  const pngImage = renderCMark(PNG_SIZE).toPNG();
  const pngPath = path.join(OUT_DIR, 'icon.png');
  writeFileSync(pngPath, pngImage);
  console.log(`wrote ${pngPath} (${pngImage.length} bytes, ${PNG_SIZE}x${PNG_SIZE})`);

  app.quit();
});
