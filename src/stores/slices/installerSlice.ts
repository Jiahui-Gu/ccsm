// Installer state slice: owns the `installerCorrupt` banner flag plus the
// `claudeSettingsDefaultModel` boot signal that seeds the new-session model
// picker. `claudeSettingsDefaultModel` is initialised to null and seeded by
// `hydrateStore()` in `store.ts` from `window.ccsm.defaultModel()`.

import type { RootStore, SetFn, GetFn } from './types';

export type InstallerSlice = Pick<
  RootStore,
  | 'claudeSettingsDefaultModel'
  | 'installerCorrupt'
  | 'setInstallerCorrupt'
>;

export function createInstallerSlice(set: SetFn, _get: GetFn): InstallerSlice {
  return {
    claudeSettingsDefaultModel: null,
    installerCorrupt: false,

    setInstallerCorrupt: (corrupt) => {
      set({ installerCorrupt: corrupt });
    },
  };
}
