// v0.3 transitional: localStorage direct (Wave 0e-1, #289). When SettingsService
// RPC ships (audit #228 sub-task 9), this module re-cuts to daemon RPC. See
// docs/superpowers/specs/2026-05-04-rpc-stub-gap-audit.md.
import type { Group, Session } from '../types';
import type { Theme, FontSize, FontSizePx } from './slices/types';

export const STATE_KEY = 'main';

/**
 * Single source of truth for store fields that flow into the persisted JSON
 * snapshot. Both the write subscriber in `hydrateStore` and the
 * reference-equality early-bail comparator (PR #166) iterate this list, so
 * adding a persisted field only requires editing this array (+ `PersistedState`).
 *
 * Excluded: `version` (literal); `sidebarWidthPct` (legacy on-disk-only,
 * read by `resolvePersistedSidebarWidth` — new writes use `sidebarWidth` px);
 * runtime-only fields like `installerCorrupt` (PR #156).
 */
export const PERSISTED_KEYS = [
  'sessions',
  'groups',
  'activeId',
  'sidebarWidth',
  'theme',
  'fontSize',
  'fontSizePx',
] as const;

export type PersistedKey = typeof PERSISTED_KEYS[number];

export interface PersistedState {
  version: 1;
  sessions: Session[];
  groups: Group[];
  activeId: string;
  /** Sidebar width in pixels. See State.sidebarWidth. */
  sidebarWidth?: number;
  /** Legacy fraction-of-window width; migrated to px on hydrate via
   * `resolvePersistedSidebarWidth`. Read-only — new writes use `sidebarWidth`. */
  sidebarWidthPct?: number;
  theme?: Theme;
  fontSize?: FontSize;
  /** Preferred over legacy `fontSize` when present. 12–16 px scale. */
  fontSizePx?: FontSizePx;
}

export async function loadPersisted(): Promise<PersistedState | null> {
  if (typeof localStorage === 'undefined') return null;
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedState;
    if (parsed.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

let writeTimer: ReturnType<typeof setTimeout> | null = null;
const WRITE_DEBOUNCE_MS = 250;

let onPersistError: ((err: unknown) => void) | null = null;
// Most-recent snapshot scheduled but not yet committed. `flushNow()` reads
// this so a synchronous flush on app shutdown still writes the latest state
// even if the debounce timer hasn't fired.
let pendingSnapshot: PersistedState | null = null;

export function setPersistErrorHandler(handler: (err: unknown) => void): void {
  onPersistError = handler;
}

/**
 * Write `value` to `localStorage[key]`, routing any throw (e.g. quota
 * exceeded) through `onPersistError` so callers share the single toast
 * sink installed by `usePersistErrorBridge`. Exported for sibling Wave 0e
 * modules cutting from removed `window.ccsm.{loadState,saveState}` IPCs.
 */
export function commitItem(key: string, value: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    if (onPersistError) onPersistError(err);
  }
}

function commitSnapshot(snap: PersistedState): void {
  commitItem(STATE_KEY, JSON.stringify(snap));
}

export function schedulePersist(state: PersistedState): void {
  if (typeof localStorage === 'undefined') return;
  pendingSnapshot = state;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    if (snap) commitSnapshot(snap);
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Synchronously dispatch any pending debounced write. Call from `beforeunload`
 * so a quick quit doesn't lose the last 250 ms; setItem is sync.
 */
export function flushNow(): void {
  if (typeof localStorage === 'undefined') return;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (snap) commitSnapshot(snap);
}
