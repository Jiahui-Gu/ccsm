import type { Group, Session } from '../types';
import type {
  Theme,
  FontSize,
  FontSizePx,
} from './slices/types';

export const STATE_KEY = 'main';

/**
 * Single source of truth for the set of store fields that flow into the
 * persisted JSON snapshot. Both the write path (subscriber in
 * `hydrateStore`) and the reference-equality early-bail comparator
 * (perf optimisation from PR #166) iterate this list, so adding a new
 * persisted field only requires editing this array (plus `PersistedState`
 * for the on-disk type).
 *
 * `version` is intentionally NOT included — it's a fixed literal stamped
 * onto every snapshot, not a store field.
 *
 * `sidebarWidthPct` is also NOT included — it's a legacy on-disk-only
 * field consumed by `resolvePersistedSidebarWidth` during hydration. New
 * writes always populate `sidebarWidth` (px) instead.
 *
 * Runtime-only fields (models, connection, installerCorrupt, etc.) are
 * intentionally NOT persisted — they're tied to the current process and
 * restoring them would block recovery on next launch. See PR #156.
 */
export const PERSISTED_KEYS = [
  'sessions',
  'groups',
  'activeId',
  'sidebarCollapsed',
  'sidebarWidth',
  'theme',
  'fontSize',
  'fontSizePx',
  'tutorialSeen',
] as const;

export type PersistedKey = typeof PERSISTED_KEYS[number];

export interface PersistedState {
  version: 1;
  sessions: Session[];
  groups: Group[];
  activeId: string;
  sidebarCollapsed: boolean;
  /** Sidebar width in pixels. See State.sidebarWidth. */
  sidebarWidth?: number;
  /**
   * Legacy: sidebar width as a fraction of window width. Migrated to px
   * (`sidebarWidth`) on hydrate via `resolvePersistedSidebarWidth`. Read-only
   * — new writes always populate `sidebarWidth`.
   */
  sidebarWidthPct?: number;
  theme?: Theme;
  fontSize?: FontSize;
  /** Preferred over legacy `fontSize` when present. 12–16 px scale. */
  fontSizePx?: FontSizePx;
  tutorialSeen?: boolean;
}

export async function loadPersisted(): Promise<PersistedState | null> {
  if (!window.ccsm) return null;
  try {
    const raw = await window.ccsm.loadState(STATE_KEY);
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

export function schedulePersist(state: PersistedState): void {
  if (!window.ccsm) return;
  pendingSnapshot = state;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    if (!snap) return;
    window.ccsm!.saveState(STATE_KEY, JSON.stringify(snap)).catch((err) => {
      if (onPersistError) onPersistError(err);
    });
  }, WRITE_DEBOUNCE_MS);
}

/**
 * Synchronously dispatch any pending debounced write. Call from `beforeunload`
 * (renderer) so a quick quit doesn't lose the last 250 ms of changes. The
 * actual saveState IPC is fire-and-forget — Electron lets the in-flight IPC
 * complete during teardown, but we don't await it here because beforeunload
 * handlers can't reliably hold the page open across async work.
 */
export function flushNow(): void {
  if (!window.ccsm) return;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (!snap) return;
  window.ccsm.saveState(STATE_KEY, JSON.stringify(snap)).catch((err) => {
    if (onPersistError) onPersistError(err);
  });
}
