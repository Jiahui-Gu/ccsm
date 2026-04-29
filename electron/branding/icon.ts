// Procedural brand "C" mark used for every CCSM icon surface:
//   - tray icon (16x16, see ensureTray in electron/main.ts)
//   - taskbar / window-title icon (multi-res NativeImage, fed to BrowserWindow.icon)
//   - installer / exe icon (rendered to build/icon.ico by scripts/build-icon.cjs
//     so electron-builder's NSIS step has a real file path)
//
// Single source of truth for the on-disk pixel design lives here. The
// build-icon.cjs script intentionally re-implements `renderCMark` in CJS
// because it runs under `npx electron` at build time and can't easily import
// a .ts module — but the constants and geometry must stay identical. When you
// change the design here, also update scripts/build-icon.cjs and re-run it
// to regenerate build/icon.ico.
//
// History:
//   PR #512 (#608): introduced the procedural "C" mark for the tray icon
//     (replacing a flat white-on-transparent square that was invisible on
//     light tray backgrounds).
//   #630: extracted to its own module + extended to multi-resolution so the
//     same mark drives the taskbar and installer, unifying branding across
//     surfaces (user dogfood: taskbar showed default Electron logo while
//     tray showed the brand "C").

import { nativeImage, type NativeImage } from 'electron';

// Brand accent (warm orange) — readable on both white and black tray
// backgrounds without needing per-theme variants. 0xE07A3F = oklch(~0.68 0.16 50),
// same family as --accent in the renderer's design tokens.
const FG_R = 0xe0;
const FG_G = 0x7a;
const FG_B = 0x3f;

// Render the "C" mark at an arbitrary square size into a raw RGBA buffer.
//
// Geometry constants are scaled from the original 16x16 design (rInner =
// rOuter - 3, arcGapHalf = 2.2) so the 256x256 installer-size version is
// visually identical to the 16x16 tray version. Anti-aliasing on the outer
// edge also scales with size so the rendered ring keeps the same proportional
// softness regardless of resolution.
export function renderCMarkBuffer(size: number): Buffer {
  const buf = Buffer.alloc(size * size * 4);
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
  return buf;
}

// 16x16 NativeImage for the system tray. Kept as its own export so the tray
// call site can remain a one-liner and the runtime cost is minimal (one
// 1KB buffer, rendered once per tray init).
export function buildTrayIcon(): NativeImage {
  const size = 16;
  return nativeImage.createFromBuffer(renderCMarkBuffer(size), { width: size, height: size });
}

// Multi-resolution NativeImage for BrowserWindow.icon. Electron picks the
// representation whose dimensions best match what the OS asks for (small
// icon for taskbar / Alt-Tab thumbnail, large icon for the window-switcher
// preview). Without this, Windows falls back to the executable's embedded
// icon resource (which we ALSO provide via build/icon.ico for the installer)
// or the default Electron atom logo when running unpackaged in dev.
//
// Sizes mirror what build/icon.ico ships, so the Win11 task-switcher and the
// taskbar stay pixel-consistent with whatever the OS picks.
const APP_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256] as const;

export function buildAppIcon(): NativeImage {
  const img = nativeImage.createEmpty();
  for (const size of APP_ICON_SIZES) {
    img.addRepresentation({
      width: size,
      height: size,
      buffer: renderCMarkBuffer(size),
      // scaleFactor stays 1 because each representation IS a distinct pixel
      // size (not a hi-DPI variant of one logical size). Electron's icon
      // picker on Windows uses the width/height pair, not scaleFactor.
      scaleFactor: 1
    });
  }
  return img;
}
