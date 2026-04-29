// Tray + taskbar unread badge.
//
// Maintains a per-sid unread map. On every change recomputes the total and
// pushes it to the OS:
//   * macOS / Linux: app.setBadgeCount(n)
//   * Windows: BrowserWindow.setOverlayIcon for every visible window AND
//     tray.setImage with the base tray icon composited with the badge.
//
// Display rule: 1-9 shows the digit; >=10 shows "9+". 0 clears.
//
// Renders nativeImages at runtime (no PNG asset files). The total badge
// images we ever build is 11 (1..9, 9+, plus the bare base for tray-clear),
// per scale, so caching is trivial and there's no perf concern.

import { app, BrowserWindow, nativeImage, type NativeImage, type Tray } from 'electron';
import { tBadge } from '../i18n';

// MVP: OS-visible badge display is disabled (#667). User reported the count
// shown on the taskbar overlay + tray icon was incorrect; rather than
// re-derive the count logic before MVP we suppress every OS-facing call so
// neither chrome surface shows a number. The internal `unread` map keeps
// running because the e2e probe (caseNotifyFiresOnIdle) reads it via
// `BadgeManager.getTotal()` to verify the notify bridge fired — that signal
// is decoupled from the visual badge. Flip this flag back to false to
// restore the previous tray composite + setOverlayIcon + setBadgeCount
// behaviour without touching anything else.
const BADGE_DISABLED = true;

export interface BadgeManagerDeps {
  getTray: () => Tray | null;
  getBaseTrayImage: () => NativeImage;
  getWindows: () => BrowserWindow[];
}

const TRAY_SIZE = 16;
const OVERLAY_SIZE = 16;

export class BadgeManager {
  private unread = new Map<string, number>();
  private deps: BadgeManagerDeps;
  private trayCache = new Map<string, NativeImage>();
  private overlayCache = new Map<string, NativeImage>();

  constructor(deps: BadgeManagerDeps) {
    this.deps = deps;
  }

  incrementSid(sid: string): void {
    if (!sid) return;
    this.unread.set(sid, (this.unread.get(sid) ?? 0) + 1);
    this.apply();
  }

  clearSid(sid: string): void {
    if (!sid) return;
    if (!this.unread.has(sid)) return;
    this.unread.delete(sid);
    this.apply();
  }

  clearAll(): void {
    if (this.unread.size === 0) return;
    this.unread.clear();
    this.apply();
  }

  getTotal(): number {
    let n = 0;
    for (const v of this.unread.values()) n += v;
    return n;
  }

  reapply(): void {
    this.apply();
  }

  private apply(): void {
    const total = this.getTotal();

    if (BADGE_DISABLED) {
      // OS-visible badge suppressed (#667). Internal `unread` map still
      // tracks per-sid counters for any consumer that cares (e.g., the
      // notify-fires e2e probe reads `getTotal()`).
      return;
    }

    if (process.platform !== 'win32') {
      try {
        app.setBadgeCount(total);
      } catch (err) {
        console.warn('[badge] setBadgeCount failed', err);
      }
      return;
    }

    // Windows: taskbar overlay + tray composite.
    const label = badgeLabel(total);
    const overlay = total > 0 ? this.getOverlay(label) : null;
    const altText = total > 0 ? tBadge('unreadOverlay', { n: label }) : '';
    for (const w of this.deps.getWindows()) {
      if (!w || w.isDestroyed()) continue;
      try {
        w.setOverlayIcon(overlay, altText);
      } catch (err) {
        console.warn('[badge] setOverlayIcon failed', err);
      }
    }

    const tray = this.deps.getTray();
    if (tray) {
      try {
        const trayImg =
          total > 0 ? this.getTrayComposite(label) : this.deps.getBaseTrayImage();
        tray.setImage(trayImg);
      } catch (err) {
        console.warn('[badge] tray.setImage failed', err);
      }
    }
  }

  private getOverlay(label: string): NativeImage {
    const cached = this.overlayCache.get(label);
    if (cached) return cached;
    const img = renderBadgeImage(label, OVERLAY_SIZE);
    this.overlayCache.set(label, img);
    return img;
  }

  private getTrayComposite(label: string): NativeImage {
    const cached = this.trayCache.get(label);
    if (cached) return cached;
    const base = this.deps.getBaseTrayImage();
    const img = compositeTrayImage(base, label, TRAY_SIZE);
    this.trayCache.set(label, img);
    return img;
  }
}

export function badgeLabel(n: number): string {
  if (n <= 0) return '';
  if (n >= 10) return '9+';
  return String(n);
}

// ---------- Pixel rendering ----------------------------------------------

// 3x5 bitmap font for digits + '+'. Each glyph is 5 rows of 3 columns.
// 1 = ink, 0 = transparent. '+' is rendered into the same 3x5 cell.
const GLYPHS: Record<string, number[][]> = {
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

const GLYPH_W = 3;
const GLYPH_H = 5;

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const RED: Rgba = { r: 0xdc, g: 0x26, b: 0x26, a: 0xff };
const WHITE: Rgba = { r: 0xff, g: 0xff, b: 0xff, a: 0xff };
const TRANSPARENT: Rgba = { r: 0, g: 0, b: 0, a: 0 };

// Renders an unread-badge nativeImage at the requested square size.
// Red filled circle background; white digit(s) centered on top.
function renderBadgeImage(label: string, size: number): NativeImage {
  const buf = Buffer.alloc(size * size * 4);
  fillCircle(buf, size, RED);
  drawLabel(buf, size, label, WHITE);
  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

// Composites the badge onto the bottom-right corner of the tray base icon.
function compositeTrayImage(
  base: NativeImage,
  label: string,
  size: number,
): NativeImage {
  const baseBuf = base.toBitmap();
  const baseSize = base.getSize();
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
      buf[di + 0] = baseBuf[si + 2];
      buf[di + 1] = baseBuf[si + 1];
      buf[di + 2] = baseBuf[si + 0];
      buf[di + 3] = baseBuf[si + 3];
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

  return nativeImage.createFromBuffer(buf, { width: size, height: size });
}

function fillCircle(buf: Buffer, size: number, color: Rgba): void {
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
function drawLabel(buf: Buffer, size: number, label: string, ink: Rgba): void {
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
    const ch = label[ci];
    const glyph = GLYPHS[ch];
    if (!glyph) continue;
    const gx0 = startX + ci * (glyphW + gap);
    for (let gy = 0; gy < GLYPH_H; gy++) {
      for (let gx = 0; gx < GLYPH_W; gx++) {
        if (!glyph[gy][gx]) continue;
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

function blit(
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
      const sa = src[si + 3];
      if (sa === 0) continue;
      const dx = ox + x;
      const dy = oy + y;
      if (dx < 0 || dx >= dstSize || dy < 0 || dy >= dstSize) continue;
      const di = (dy * dstSize + dx) * 4;
      // Source-over alpha blend.
      const a = sa / 255;
      const inv = 1 - a;
      dst[di + 0] = Math.round(src[si + 0] * a + dst[di + 0] * inv);
      dst[di + 1] = Math.round(src[si + 1] * a + dst[di + 1] * inv);
      dst[di + 2] = Math.round(src[si + 2] * a + dst[di + 2] * inv);
      dst[di + 3] = Math.max(dst[di + 3], sa);
    }
  }
}
