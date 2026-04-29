// OS-visible unread-badge sink.
//
// SRP: this module is the *sink*-tier executor for the unread badge. It
// subscribes to `BadgeManager.change` events and pushes the total to the
// OS chrome:
//   * macOS / Linux: app.setBadgeCount(n)
//   * Windows: BrowserWindow.setOverlayIcon for every visible window AND
//     tray.setImage with the base tray icon composited with the badge.
//
// Image rendering is delegated to the pure `badgePixels` module; the label
// rule lives in `badgeLabel`. This sink only owns the OS calls + the
// per-label NativeImage caches.
//
// Display rule (handled by badgeLabel): 1-9 shows the digit; >=10 shows
// "9+"; 0 clears. No PNG asset files — the pixel buffers are computed at
// runtime and the total set we ever build is 11 (1..9, 9+, plus the bare
// base for tray-clear), per scale, so caching is trivial.

import {
  app,
  BrowserWindow,
  nativeImage,
  type NativeImage,
  type Tray,
} from 'electron';
import { tBadge } from '../../i18n';
import type { BadgeManager } from '../badgeStore';
import { badgeLabel } from '../badgeLabel';
import {
  compositeTrayImage,
  renderBadgeImage,
  type BgraBitmap,
} from '../badgePixels';

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

const TRAY_SIZE = 16;
const OVERLAY_SIZE = 16;

export interface BadgeSinkDeps {
  getTray: () => Tray | null;
  getBaseTrayImage: () => NativeImage;
  getWindows: () => BrowserWindow[];
}

export interface BadgeSink {
  /** Detach the change listener. Useful for tests / teardown. */
  dispose(): void;
}

export function createBadgeSink(
  store: BadgeManager,
  deps: BadgeSinkDeps,
): BadgeSink {
  const trayCache = new Map<string, NativeImage>();
  const overlayCache = new Map<string, NativeImage>();

  function getOverlay(label: string): NativeImage {
    const cached = overlayCache.get(label);
    if (cached) return cached;
    const img = renderBadgeImage(label, OVERLAY_SIZE);
    const native = nativeImage.createFromBuffer(img.buffer, {
      width: img.width,
      height: img.height,
    });
    overlayCache.set(label, native);
    return native;
  }

  function getTrayComposite(label: string): NativeImage {
    const cached = trayCache.get(label);
    if (cached) return cached;
    const base = deps.getBaseTrayImage();
    const baseBitmap: BgraBitmap = {
      buffer: base.toBitmap(),
      width: base.getSize().width,
      height: base.getSize().height,
    };
    const img = compositeTrayImage(baseBitmap, label, TRAY_SIZE);
    const native = nativeImage.createFromBuffer(img.buffer, {
      width: img.width,
      height: img.height,
    });
    trayCache.set(label, native);
    return native;
  }

  function apply(total: number): void {
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
        console.warn('[badgeSink] setBadgeCount failed', err);
      }
      return;
    }

    // Windows: taskbar overlay + tray composite.
    const label = badgeLabel(total);
    const overlay = total > 0 ? getOverlay(label) : null;
    const altText = total > 0 ? tBadge('unreadOverlay', { n: label }) : '';
    for (const w of deps.getWindows()) {
      if (!w || w.isDestroyed()) continue;
      try {
        w.setOverlayIcon(overlay, altText);
      } catch (err) {
        console.warn('[badgeSink] setOverlayIcon failed', err);
      }
    }

    const tray = deps.getTray();
    if (tray) {
      try {
        const trayImg =
          total > 0 ? getTrayComposite(label) : deps.getBaseTrayImage();
        tray.setImage(trayImg);
      } catch (err) {
        console.warn('[badgeSink] tray.setImage failed', err);
      }
    }
  }

  store.on('change', apply);

  return {
    dispose() {
      store.off('change', apply);
    },
  };
}
