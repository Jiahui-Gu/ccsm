// Shared slice types. Slices return partials of the root `State & Actions`
// shape; this module hosts the types the slices need without re-importing
// from `../store.ts` (which would create a cycle since `store.ts` imports
// every slice). The store re-exports the public-facing types so existing
// call sites continue to import from `../store`.

import type { Group, Session, SessionState } from '../../types';

export type ModelId = string;
export type PermissionMode =
  | 'plan'
  | 'default'
  | 'acceptEdits'
  | 'bypassPermissions'
  | 'auto';
export type Theme = 'system' | 'light' | 'dark';
export type FontSize = 'sm' | 'md' | 'lg';
export type FontSizePx = 12 | 13 | 14 | 15 | 16;

/** Terminal scrollback line cap. Single user-facing knob for both the
 *  visible xterm (next-launch effect) and the headless authoritative buffer
 *  in main (next-spawn effect). Range enforced by `sanitizeScrollbackLines`
 *  (mirrors the main-side `parseScrollbackLines`). */
export const SCROLLBACK_LINES_DEFAULT = 1500;
export const SCROLLBACK_LINES_MIN = 100;
export const SCROLLBACK_LINES_MAX = 50000;

export type EndpointKind =
  | 'anthropic'
  | 'openai-compat'
  | 'ollama'
  | 'bedrock'
  | 'vertex'
  | 'unknown';

export interface CreateSessionOptions {
  cwd?: string | null;
  name?: string;
  groupId?: string;
}

export interface SessionSnapshot {
  session: Session;
  index: number;
  draft: string;
  prevActiveId: string;
}

export interface GroupSnapshot {
  group: Group;
  groupIndex: number;
  sessions: SessionSnapshot[];
  prevActiveId: string;
  prevFocusedGroupId: string | null;
}

/** Root store shape — everything the renderer can read or call. Composed
 * from the 5 slices in `store.ts`. Extracted here so slice modules can
 * type their `set`/`get` against the full union without circular-importing
 * `store.ts`. */
export type State = {
  sessions: Session[];
  groups: Group[];
  userHome: string;
  claudeSettingsDefaultModel: string | null;
  activeId: string;
  focusedGroupId: string | null;
  sidebarWidth: number;
  theme: Theme;
  fontSize: FontSize;
  fontSizePx: FontSizePx;
  scrollbackLines: number;
  flashStates: Record<string, boolean>;
  hydrated: boolean;
  installerCorrupt: boolean;
  openPopoverId: string | null;
  disconnectedSessions: Record<
    string,
    { kind: 'clean' | 'crashed'; code: number | null; signal: string | number | null; at: number }
  >;
  /**
   * Per-session counter bumped by `reloadSession()` to force the
   * `usePtyAttach` effect to re-run for an unchanged sid (kill the
   * current pty, then re-spawn via the existing spawn-on-null fallback).
   * Not persisted — purely a transient nudge for the attach hook.
   */
  reloadNonce: Record<string, number>;
};

export type Actions = {
  // sessions
  selectSession: (id: string) => void;
  focusGroup: (id: string | null) => void;
  createSession: (cwd: string | null | CreateSessionOptions) => void;
  importSession: (opts: {
    name: string;
    cwd: string;
    groupId: string;
    resumeSessionId: string;
    projectDir?: string;
  }) => string;
  renameSession: (id: string, name: string) => Promise<void>;
  _applyExternalTitle: (sid: string, title: string) => void;
  _applySessionState: (sid: string, state: SessionState) => void;
  _setFlash: (sid: string, on: boolean) => void;
  _applyCwdRedirect: (sid: string, newCwd: string) => void;
  _applyPtyExit: (
    sid: string,
    payload: { code: number | null; signal: string | number | null }
  ) => void;
  _clearPtyExit: (sid: string) => void;
  /**
   * Right-click "Reload session" — kill the current pty and bump the
   * per-session reload nonce so the `usePtyAttach` effect re-runs and
   * spawns a fresh pty (via the existing spawn-on-null fallback).
   * Used to pick up env / config changes that require a new claude process.
   */
  reloadSession: (sid: string) => Promise<void>;
  _backfillTitles: () => Promise<void>;
  deleteSession: (id: string) => SessionSnapshot | null;
  restoreSession: (snapshot: SessionSnapshot) => void;
  moveSession: (
    sessionId: string,
    targetGroupId: string,
    beforeSessionId: string | null
  ) => void;
  changeCwd: (cwd: string) => void;
  setSessionModel: (sessionId: string, model: ModelId) => void;
  archiveSession: (sessionId: string) => void;
  unarchiveSession: (sessionId: string) => void;

  // appearance
  setTheme: (theme: Theme) => void;
  setFontSize: (size: FontSize) => void;
  setFontSizePx: (px: FontSizePx) => void;
  setScrollbackLines: (n: number) => void;
  setSidebarWidth: (px: number) => void;
  resetSidebarWidth: () => void;

  // groups
  createGroup: (name?: string) => string;
  renameGroup: (id: string, name: string) => void;
  deleteGroup: (id: string) => GroupSnapshot | null;
  restoreGroup: (snapshot: GroupSnapshot) => void;
  archiveGroup: (id: string) => void;
  unarchiveGroup: (id: string) => void;
  setGroupCollapsed: (id: string, collapsed: boolean) => void;

  // model picker
  setInstallerCorrupt: (corrupt: boolean) => void;

  // popover
  openPopover: (id: string) => void;
  closePopover: (id: string) => void;
};

export type RootStore = State & Actions;
export type SetFn = {
  (partial: Partial<RootStore> | ((s: RootStore) => Partial<RootStore> | RootStore)): void;
};
export type GetFn = () => RootStore;
