import type { Group, Session } from '../types';
import type { ModelId, PermissionMode } from './store';

export const STATE_KEY = 'main';

export interface PersistedState {
  version: 1;
  sessions: Session[];
  groups: Group[];
  activeId: string;
  model: ModelId;
  permission: PermissionMode;
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

export function schedulePersist(state: PersistedState): void {
  if (!window.agentory) return;
  if (writeTimer) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    window.agentory!.saveState(STATE_KEY, JSON.stringify(state)).catch(() => {});
  }, WRITE_DEBOUNCE_MS);
}
