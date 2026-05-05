// `window.ccsmSessionTitles` — thin renderer-side bridge to the
// main-process `electron/sessionTitles` module, which wraps
// `@anthropic-ai/claude-agent-sdk`'s `getSessionInfo` / `renameSession` /
// `listSessions`. The substrate concerns (per-sid serialization, 2s TTL
// cache, ENOENT classification, pending-rename queue) live entirely on
// the main side; the renderer only sees a flat get/rename/listForProject
// surface. Wired in PR2 by the `renameSession` store action; consumed in
// PR3 by the watcher and PR4 by launch-time backfill.
//
// Extracted from `electron/preload.ts` in #769 (SRP wave-2 PR-A).

import { contextBridge, ipcRenderer } from 'electron';

type SessionTitleSummary = {
  summary: string | null;
  mtime: number | null;
};

type SessionTitleRenameResult =
  | { ok: true }
  | { ok: false; reason: 'no_jsonl' | 'sdk_threw'; message?: string };

type SessionTitleProjectEntry = {
  sid: string;
  summary: string | null;
  mtime: number;
};

const ccsmSessionTitles = {
  get: (sid: string, dir?: string): Promise<SessionTitleSummary> =>
    ipcRenderer.invoke('sessionTitles:get', sid, dir),
  rename: (
    sid: string,
    title: string,
    dir?: string
  ): Promise<SessionTitleRenameResult> =>
    ipcRenderer.invoke('sessionTitles:rename', sid, title, dir),
  listForProject: (projectKey: string): Promise<SessionTitleProjectEntry[]> =>
    ipcRenderer.invoke('sessionTitles:listForProject', projectKey),
  // Pending-rename queue (PR2). When `rename` returns `{ok:false,
  // reason:'no_jsonl'}` the store calls `enqueuePending` so the title is
  // remembered locally; PR3's sessionWatcher invokes `flushPending` once the
  // JSONL appears. The queue lives in-memory in main and is intentionally
  // not persisted — see `electron/sessionTitles/index.ts` header.
  enqueuePending: (sid: string, title: string, dir?: string): Promise<void> =>
    ipcRenderer.invoke('sessionTitles:enqueuePending', sid, title, dir),
  flushPending: (sid: string): Promise<void> =>
    ipcRenderer.invoke('sessionTitles:flushPending', sid),
};

export type CCSMSessionTitlesAPI = typeof ccsmSessionTitles;

export function installCcsmSessionTitlesBridge(): void {
  contextBridge.exposeInMainWorld('ccsmSessionTitles', ccsmSessionTitles);
}
