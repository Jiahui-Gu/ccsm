/**
 * `window.ccsmSessionTitles` — preload bridge stub for the v0.3 daemon transition.
 *
 * Wave-2-C replaces with real fetch shim against `/api/sessionTitles/*`.
 * Until then, get returns null, listForProject returns [], flushPending noops.
 * This matches the "title not yet known" state the renderer already handles.
 */

import { contextBridge } from "electron";

const ccsmSessionTitles = {
  get: (_sid: string): Promise<string | null> => Promise.resolve(null),
  listForProject: (_projectId: string): Promise<unknown[]> => Promise.resolve([]),
  flushPending: (): Promise<void> => Promise.resolve(),
} as const;

export type CcsmSessionTitlesApi = typeof ccsmSessionTitles;

export function installCcsmSessionTitlesBridge(): void {
  contextBridge.exposeInMainWorld("ccsmSessionTitles", ccsmSessionTitles);
}
