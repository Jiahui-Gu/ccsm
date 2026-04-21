import type { Group, Session } from '../types';
import type {
  PermissionMode,
  Theme,
  FontSize,
  WatchdogConfig,
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
  theme?: Theme;
  fontSize?: FontSize;
  recentProjects?: RecentProject[];
  tutorialSeen?: boolean;
  watchdog?: WatchdogConfig;
  /**
   * Default endpoint id for new sessions. Persisted so the user's pick survives
   * restarts. Falls back to the endpoint with is_default=1 if missing.
   */
  defaultEndpointId?: string | null;
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

export function setPersistErrorHandler(handler: (err: unknown) => void): void {
  onPersistError = handler;
}

export function schedulePersist(state: PersistedState): void {
  if (!window.agentory) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    window.agentory!.saveState(STATE_KEY, JSON.stringify(state)).catch((err) => {
      if (onPersistError) onPersistError(err);
    });
  }, WRITE_DEBOUNCE_MS);
}
