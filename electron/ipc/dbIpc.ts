// db-scoped IPC handlers. Extracted from electron/main.ts (Task #742 Phase B).
//
// Owns the renderer-facing key/value persistence surface backed by the SQLite
// `app_state` table (see electron/db). Validation lives in electron/db-validate
// so it can be unit-tested without an IPC round-trip; this module is a thin
// wrapper that adds the security guard, oversize-rejection log, and emits a
// `stateSaved` event after a successful write.
//
// Decoupling note (Task #818 / `tech-debt-12-functional-core.md` leak #5):
// this module no longer knows which prefs caches care about which keys. After
// a successful save it just emits `stateSaved(key)` on the shared bus
// (`electron/shared/stateSavedBus.ts`); cache owners (`electron/prefs/*`)
// subscribe to the bus and decide for themselves whether the key is theirs.

import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { loadState, saveState } from '../db';
import { validateSaveStateInput } from '../db-validate';
import { fromMainFrame } from '../security/ipcGuards';
import { emitStateSaved } from '../shared/stateSavedBus';

export interface DbIpcDeps {
  ipcMain: IpcMain;
}

/** Pure handler for `db:save`. Exported for unit testing — verifies the
 *  guard / validation / persistence / emit chain without an actual
 *  IPC round-trip. */
export function handleDbSave(
  e: IpcMainInvokeEvent,
  key: string,
  value: string,
): { ok: true } | { ok: false; error: string } {
  if (!fromMainFrame(e)) return { ok: false, error: 'rejected' };
  const v = validateSaveStateInput(key, value);
  if (!v.ok) {
    if (v.error === 'value_too_large') {
      console.warn(
        `[main] db:save rejecting oversized value (${(value as string).length} bytes) for key=${key}`,
      );
    }
    return v;
  }
  // Wrap the sqlite write so a disk error (full disk, locked WAL, corrupt
  // db) becomes a {ok:false} discriminant instead of crossing the IPC bridge
  // as Electron's opaque "An object could not be cloned" rejection. The
  // renderer's preload `saveState` wrapper unwraps this and re-throws so
  // `setPersistErrorHandler` fires with a useful message. Audit risk #1.
  try {
    saveState(key, value);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[main] db:save failed for key=${key}:`, err);
    return { ok: false, error: msg };
  }
  // Notify any subscribed cache owners that this key was written. Bus
  // listeners are responsible for filtering by key (see prefs/*).
  emitStateSaved(key);
  return { ok: true };
}

/** Pure handler for `db:load`. Exported for unit testing. Returns `null` on
 *  any sqlite read error so the renderer falls through to its default state
 *  instead of receiving an opaque IPC rejection (Electron surfaces those as
 *  "An object could not be cloned"). Audit risk #6. The cost of degrading to
 *  null is a one-time blank app on a corrupt db; the alternative is a hard
 *  bridge error with no diagnostic. The error is logged so dogfood surfaces
 *  the underlying cause. */
export function handleDbLoad(
  _e: IpcMainInvokeEvent,
  key: string,
): string | null {
  try {
    return loadState(key);
  } catch (err) {
    console.error(`[main] db:load failed for key=${key}:`, err);
    return null;
  }
}

export function registerDbIpc(deps: DbIpcDeps): void {
  const { ipcMain } = deps;
  ipcMain.handle('db:load', handleDbLoad);
  // Cap renderer-supplied state values. Mirrors the per-block cap in the
  // (now-retired) db:saveMessages handler but tighter (1 MB total): a single
  // app_state row holds drafts/persist snapshots that should never approach
  // this size — if one does, it's a bug in the persister and we refuse to
  // commit it rather than silently growing the WAL.
  ipcMain.handle('db:save', handleDbSave);
}
