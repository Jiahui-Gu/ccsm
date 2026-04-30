// Tray + taskbar unread badge — thin facade.
//
// Task #744 Phase B: this module was split into three SRP-pure pieces:
//   * `badgeStore.ts`   — per-sid unread counter + change emitter (decider)
//   * `sinks/badgeSink.ts` — OS-facing executor (Notification/setOverlayIcon
//                            /tray.setImage) + NativeImage caches
//   * `badgePixels.ts` / `badgeLabel.ts` — pure pixel + label helpers (#549)
//
// This file is kept as a backward-compat facade so existing call sites
// (electron/main.ts, electron/badgeController.ts, the badgeController test)
// can keep using `new BadgeManager({ getTray, getBaseTrayImage, getWindows })`
// unchanged. The constructor instantiates the underlying store and wires
// the OS sink in one step. Callers who need pure state with no OS coupling
// can import `BadgeManager` from `./badgeStore` directly.

import { BadgeManager as BadgeStore } from './badgeStore';
import { createBadgeSink, type BadgeSinkDeps } from './sinks/badgeSink';

export type BadgeManagerDeps = BadgeSinkDeps;

export class BadgeManager extends BadgeStore {
  constructor(deps: BadgeManagerDeps) {
    super();
    createBadgeSink(this, deps);
  }
}

// Re-export the pure label helper so any legacy importer of
// `badgeLabel` from this module keeps compiling.
export { badgeLabel } from './badgeLabel';
