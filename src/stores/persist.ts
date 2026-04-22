import type { Group, Session } from '../types';
import type {
  PermissionMode,
  Theme,
  FontSize,
  FontSizePx,
  Density,
  NotificationSettings
} from './store';
import type { RecentProject } from '../mock/data';

export const STATE_KEY = 'main';

export interface PersistedState {
  version: 1;
  sessions: Session[];
  groups: Group[];
  activeId: string;
  model: string;
  // Loose type: older builds persisted legacy literals like `standard` /
  // `ask` / `auto` / `yolo`. `migratePermission` in store.ts normalises on
  // read. Writes always use the current `PermissionMode`.
  permission: PermissionMode | string;
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
  /** UI density (compact/normal/comfortable). */
  density?: Density;
  recentProjects?: RecentProject[];
  tutorialSeen?: boolean;
  notificationSettings?: NotificationSettings;
}

export async function loadPersisted(): Promise<PersistedState | null> {
  if (!window.agentory) return null;
  try {
    const raw = await window.agentory.loadState(STATE_KEY);
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
  if (!window.agentory) return;
  pendingSnapshot = state;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snap = pendingSnapshot;
    pendingSnapshot = null;
    if (!snap) return;
    window.agentory!.saveState(STATE_KEY, JSON.stringify(snap)).catch((err) => {
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
  if (!window.agentory) return;
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const snap = pendingSnapshot;
  pendingSnapshot = null;
  if (!snap) return;
  window.agentory.saveState(STATE_KEY, JSON.stringify(snap)).catch((err) => {
    if (onPersistError) onPersistError(err);
  });
}
