// Close-button preference. Extracted from electron/main.ts (Task #730 Phase A1).
//
// 'ask'  → one-time dialog the first time the user clicks the X (default on
//          Windows/Linux).
// 'tray' → silently minimize to the tray (mac default — matches OS red-light
//          convention).
// 'quit' → really quit.
//
// Persisted in app_state under key `closeAction` so the choice survives
// restart. Read synchronously inside win.on('close') because the close event
// itself is sync; the SQLite read is a single point lookup (sub-millisecond)
// so the cost is negligible vs. the visible click latency.

import { loadState, saveState } from '../db';

export type CloseAction = 'ask' | 'tray' | 'quit';

export const CLOSE_ACTION_KEY = 'closeAction';

// Pure parser for the persisted close-action value. Decider only — no I/O.
// Invalid / missing values fall back to the platform default ('tray' on
// macOS to match the OS red-light convention, 'ask' elsewhere).
export function parseCloseAction(raw: unknown, platform: NodeJS.Platform): CloseAction {
  if (raw === 'ask' || raw === 'tray' || raw === 'quit') return raw;
  return platform === 'darwin' ? 'tray' : 'ask';
}

export function getCloseAction(): CloseAction {
  let raw: string | null = null;
  try {
    raw = loadState(CLOSE_ACTION_KEY);
  } catch {
    /* fall through to default */
  }
  return parseCloseAction(raw, process.platform);
}

export function setCloseAction(value: CloseAction): void {
  try {
    saveState(CLOSE_ACTION_KEY, value);
  } catch (err) {
    console.warn('[main] setCloseAction failed', err);
  }
}
