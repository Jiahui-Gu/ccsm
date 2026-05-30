// Session CRUD slice: create / import / delete / restore / move /
// rename / changeCwd / setSessionModel + active selection.
//
// Composed from three cohesive sub-slices (verb-group split per DEBT #4):
//   `sessionCreateSlice`   — create / import / copy + their seeded state
//                            (userHome, claudeSettingsDefaultModel,
//                            pendingForkSource).
//   `sessionMutationSlice` — select / focus / rename / delete / restore /
//                            move / changeCwd / setSessionModel /
//                            consumePendingRename.
//   `sessionArchiveSlice`  — archive / unarchive.
// Shared pure helpers (id minting, `ensureUsableGroup`, rename enqueue)
// live in `../lib/sessionCrudHelpers`.
//
// `userHome` and `claudeSettingsDefaultModel` are read by `createSession`
// but live as initial state on this slice (sessions are the main consumer
// of those boot-seeded values).
//
// Runtime mutations (`_apply*`, flash, disconnected state) live on
// `sessionRuntimeSlice`. Title backfill / SDK-derived title sync lives on
// `sessionTitleBackfillSlice` (split per Task #736 / PR #754 review).

import { createSessionCreateSlice } from './sessionCreateSlice';
import { createSessionMutationSlice } from './sessionMutationSlice';
import { createSessionArchiveSlice } from './sessionArchiveSlice';
import type {
  RootStore,
  SetFn,
  GetFn,
} from './types';

export type SessionCrudSlice = Pick<
  RootStore,
  | 'sessions'
  | 'activeId'
  | 'focusedGroupId'
  | 'userHome'
  | 'claudeSettingsDefaultModel'
  | 'selectSession'
  | 'focusGroup'
  | 'createSession'
  | 'importSession'
  | 'renameSession'
  | 'deleteSession'
  | 'restoreSession'
  | 'moveSession'
  | 'changeCwd'
  | 'setSessionModel'
  | 'archiveSession'
  | 'unarchiveSession'
  | 'pendingRenameId'
  | 'pendingForkSource'
  | 'copySession'
  | 'consumePendingRename'
>;

export function createSessionCrudSlice(set: SetFn, get: GetFn): SessionCrudSlice {
  return {
    ...createSessionCreateSlice(set, get),
    ...createSessionMutationSlice(set, get),
    ...createSessionArchiveSlice(set, get),
  };
}
