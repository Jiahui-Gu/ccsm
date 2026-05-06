import { useEffect } from 'react';
import { useStore } from '../stores/store';

/**
 * Task #639 — wire the daemon's storage-health signal into the store so
 * `<StorageHealthBanner />` paints when initDb failed (better-sqlite3 ABI
 * mismatch / EACCES on userdata dir / sqlite corruption /
 * `CCSM_TEST_BREAK_DB=1` test seam).
 *
 * Two channels because the renderer's mount and main's spawn-time probe
 * race:
 *   1. Pull (`getStorageHealth`): grabs main's cached snapshot
 *      synchronously on hook-mount so a window that mounts AFTER the
 *      probe lands still picks up the failure without waiting for a push.
 *   2. Subscribe (`onStorageHealth`): catches a snapshot main pushes
 *      AFTER mount — typically because the daemon spawn takes longer
 *      than first paint.
 *
 * Idempotent against double-fire (HMR re-mount): `setStorageHealth` just
 * replaces the slot; the banner subscribes to the latest value.
 */
export function useStorageHealthBridge(): void {
  const setStorageHealth = useStore((s) => s.setStorageHealth);
  useEffect(() => {
    let cancelled = false;
    const api = window.ccsm;
    if (!api) return;
    // (1) Pull the cached snapshot from main. `getStorageHealth` returns
    // null when main hasn't probed yet — leave the store untouched in
    // that case so the banner stays hidden until we hear good or bad.
    if (api.getStorageHealth) {
      api.getStorageHealth().then(
        (h) => {
          if (cancelled) return;
          if (h) setStorageHealth(h);
        },
        () => {
          /* IPC unavailable — leave storageHealth at its initial null */
        },
      );
    }
    // (2) Subscribe to push fanouts. Main re-fans the snapshot whenever
    // its storage-health probe lands (or, in the future, escalates).
    let off: (() => void) | undefined;
    if (api.onStorageHealth) {
      off = api.onStorageHealth((h) => {
        setStorageHealth(h);
      });
    }
    return () => {
      cancelled = true;
      off?.();
    };
  }, [setStorageHealth]);
}
