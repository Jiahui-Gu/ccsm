// Model picker slice: discovered models list + connection profile +
// `installerCorrupt` banner flag + `claudeSettingsDefaultModel` boot
// signal. Owns the renderer-side IPC reads (`loadModels`,
// `loadConnection`); per-session model writes live in `sessionsSlice`
// (`setSessionModel`) since they touch the session row, not picker state.
//
// `claudeSettingsDefaultModel` is initialised to null and seeded by
// `hydrateStore()` in `store.ts` from `window.ccsm.defaultModel()`.

import type { ConnectionInfo, RootStore, SetFn, GetFn } from './types';

export type ModelPickerSlice = Pick<
  RootStore,
  | 'models'
  | 'modelsLoaded'
  | 'connection'
  | 'claudeSettingsDefaultModel'
  | 'installerCorrupt'
  | 'loadModels'
  | 'loadConnection'
  | 'setInstallerCorrupt'
>;

export function createModelPickerSlice(set: SetFn, _get: GetFn): ModelPickerSlice {
  return {
    models: [],
    modelsLoaded: false,
    connection: null,
    claudeSettingsDefaultModel: null,
    installerCorrupt: false,

    loadModels: async () => {
      const api = window.ccsm;
      if (!api?.models?.list) {
        set({ modelsLoaded: true });
        return;
      }
      try {
        const list = await api.models.list();
        set({ models: list, modelsLoaded: true });
      } catch {
        set({ modelsLoaded: true });
      }
    },

    loadConnection: async () => {
      const api = window.ccsm;
      if (!api?.connection?.read) return;
      try {
        const info: ConnectionInfo = await api.connection.read();
        set({ connection: info });
      } catch {
        /* IPC failed — leave connection as null */
      }
    },

    setInstallerCorrupt: (corrupt) => {
      set({ installerCorrupt: corrupt });
    },
  };
}
