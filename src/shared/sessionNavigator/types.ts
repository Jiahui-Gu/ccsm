export const SESSION_NAVIGATOR_MESSAGE_VERSION = 1 as const;

export type SessionNavigatorState = 'active' | 'idle' | 'waiting' | 'exited';

export type SessionNavigatorSession = {
  id: string;
  name: string;
  cwd: string;
  state: SessionNavigatorState;
  order: number;
};

export type SessionNavigatorGroup = {
  id: string;
  name: string;
  order: number;
  collapsed: boolean;
  sessions: SessionNavigatorSession[];
};

export type SessionNavigatorModel = {
  groups: SessionNavigatorGroup[];
  activeSessionId: string | null;
};

export type NavigationMetadataSnapshot = {
  groups: unknown;
  sessions: unknown;
  activeId: unknown;
};
