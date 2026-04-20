import type { Group, Session } from '../types';
import type { ModelId, PermissionMode, Theme, FontSize } from './store';
import type { RecentProject } from '../mock/data';

export const STATE_KEY = 'main';

export interface PersistedState {
  version: 1;
  sessions: Session[];
  groups: Group[];
  activeId: string;
  model: ModelId;
  permission: PermissionMode;
  sidebarCollapsed: boolean;
  theme?: Theme;
  fontSize?: FontSize;
  recentProjects?: RecentProject[];
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
