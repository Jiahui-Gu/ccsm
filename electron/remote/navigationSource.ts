import { loadState } from '../db';
import { listPtySessions } from '../ptyHost';
import { buildSessionNavigatorModel } from '../../src/shared/sessionNavigator/buildModel';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator/types';

type NavigationSourceDeps = {
  loadState: (key: string) => string | null;
  listPtySessions: () => Array<{ sid: string }>;
};

const EMPTY_NAVIGATOR: SessionNavigatorModel = {
  groups: [],
  activeSessionId: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function readRemoteNavigationModel(
  deps: NavigationSourceDeps = { loadState, listPtySessions },
): SessionNavigatorModel {
  let raw: string | null;
  try {
    raw = deps.loadState('main');
  } catch {
    return EMPTY_NAVIGATOR;
  }
  if (!raw) return EMPTY_NAVIGATOR;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_NAVIGATOR;
  }

  if (
    !isRecord(parsed) ||
    parsed.version !== 1 ||
    !Array.isArray(parsed.groups) ||
    !Array.isArray(parsed.sessions)
  ) {
    return EMPTY_NAVIGATOR;
  }

  let liveSessionIds: Set<string>;
  try {
    liveSessionIds = new Set(deps.listPtySessions().map((session) => session.sid));
  } catch {
    return EMPTY_NAVIGATOR;
  }

  return buildSessionNavigatorModel(
    {
      groups: parsed.groups,
      sessions: parsed.sessions,
      activeId: parsed.activeId,
    },
    liveSessionIds,
  );
}

export function navigationSignature(model: SessionNavigatorModel): string {
  return JSON.stringify(model);
}
