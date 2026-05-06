// Installer state slice: owns the `installerCorrupt` banner flag plus the
// `claudeSettingsDefaultModel` boot signal that seeds the new-session model
// picker. `claudeSettingsDefaultModel` is initialised to null and seeded by
// `hydrateStore()` in `store.ts` from `window.ccsm.defaultModel()`.
//
// Task #639 — also owns `storageHealth`, the daemon-reported initDb
// success flag. Lives here (rather than its own slice) because the banner
// it drives sits next to InstallerCorruptBanner inside the same TopBanner
// stack and follows the same lifecycle (boot-set, never user-dismissed).

import type { RootStore, SetFn, GetFn } from './types';

export type InstallerSlice = Pick<
  RootStore,
  | 'claudeSettingsDefaultModel'
  | 'installerCorrupt'
  | 'setInstallerCorrupt'
  | 'storageHealth'
  | 'setStorageHealth'
>;

export function createInstallerSlice(set: SetFn, _get: GetFn): InstallerSlice {
  return {
    claudeSettingsDefaultModel: null,
    installerCorrupt: false,
    storageHealth: null,

    setInstallerCorrupt: (corrupt) => {
      set({ installerCorrupt: corrupt });
    },

    setStorageHealth: (h) => {
      set({ storageHealth: h });
    },
  };
}
