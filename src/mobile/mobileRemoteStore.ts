// Phone-side (browser-safe, zustand vanilla) store owning connection status,
// grouped-navigator-driven session selection, per-session drafts and their
// acknowledged submission lifecycle, drawer visibility, and the exactly-once
// terminal render batch handed to the read-only xterm adapter.
//
// This module must stay importable outside Electron: it is bundled into the
// phone PWA (webpack.mobile.config.js), never the desktop renderer or main
// process, and never touches `focus()`/`blur()` — the composer textarea is
// the only software-keyboard entry point (see mvp-design.md §15 and the
// mobile composer/terminal-sync plan's global constraints).

import { createStore, type StoreApi } from 'zustand/vanilla';

import {
  applyTerminalChunk,
  applyTerminalSnapshot,
  beginTerminalSync,
  emptyTerminalSync,
  type TerminalSyncEffect,
  type TerminalSyncState,
} from './terminalSync';

import type { PhoneConnectionStatus, RelayClient } from './relayClient';
import type { MobileClientMessage, MobileServerMessage } from '../shared/mobileRemote';
import type { SessionNavigatorModel } from '../shared/sessionNavigator';

export type TerminalRenderBatch = {
  id: number;
  effects: Array<Extract<TerminalSyncEffect, { type: 'reset' | 'write' }>>;
};

export type PendingSubmission = {
  requestId: string;
  draft: string;
};

export type RetryMode = 'automatic' | 'manual' | 'blocked';

export type MobileRemoteViewState = {
  navigator: SessionNavigatorModel;
  selectedSessionId: string | null;
  exitedSessionId: string | null;
  connection: PhoneConnectionStatus;
  inputEnabled: boolean;
  retryMode: RetryMode;
  drawerOpen: boolean;
  drafts: Record<string, string>;
  // Keyed by sid, never a single global slot: session A having an
  // unacknowledged submission must never block or clobber session B's (see
  // `submitDraft`/`applySubmitResult` below and `deriveSubmitting`, the
  // selector `PhoneShell` uses for the *selected* session's own Send state).
  pendingSubmissions: Record<string, PendingSubmission>;
  // Follow-up A fix: also keyed by sid, never a single global slot. A
  // rejected/failed submission for one session must never be visible on a
  // different, unrelated session's composer just because that other
  // session happens to be selected — and it must still be there if the
  // user navigates back to the session that actually failed. `PhoneShell`
  // never reads this map directly; it calls `deriveSubmissionError` below,
  // mirroring how `deriveSubmitting` derives the selected session's own
  // pending state from `pendingSubmissions`.
  submissionErrors: Record<string, string>;
  terminalSync: TerminalSyncState;
  terminalBatch: TerminalRenderBatch | null;
};

export type MobileRemoteActions = {
  setDraft(text: string): void;
  submitDraft(): Promise<void>;
  sendControl(data: string): void;
  selectSession(sid: string): void;
  setDrawerOpen(open: boolean): void;
  retry(): void;
  receive(message: MobileServerMessage): void;
  consumeTerminalBatch(id: number): void;
  dispose(): void;
};

export type MobileRemoteStore = MobileRemoteViewState & MobileRemoteActions;

export type MobileRemoteStoreOptions = {
  // Testable request-id seam: avoids `crypto.randomUUID as unknown as ...`
  // casts in tests while defaulting to the real Web Crypto API at runtime.
  requestId?: () => string;
};

function emptyNavigatorModel(): SessionNavigatorModel {
  return { groups: [], activeSessionId: null };
}

function initialViewState(): MobileRemoteViewState {
  return {
    navigator: emptyNavigatorModel(),
    selectedSessionId: null,
    exitedSessionId: null,
    connection: 'connecting',
    inputEnabled: false,
    retryMode: 'automatic',
    drawerOpen: false,
    drafts: {},
    pendingSubmissions: {},
    submissionErrors: {},
    terminalSync: emptyTerminalSync(),
    terminalBatch: null,
  };
}

function collectLiveSessionIds(navigator: SessionNavigatorModel): Set<string> {
  const ids = new Set<string>();
  for (const group of navigator.groups) {
    for (const session of group.sessions) {
      if (session.state === 'exited') continue;
      ids.add(session.id);
    }
  }
  return ids;
}

// First session in group order, then session order — matches the order the
// shared navigator already produces its (filtered, non-empty) `groups` and
// each group's `sessions` arrays in. Exited sessions are skipped: they may
// still be listed (e.g. so the phone can show a just-exited session briefly)
// but are never a live selection candidate.
function firstLiveSessionId(navigator: SessionNavigatorModel): string | null {
  for (const group of navigator.groups) {
    for (const session of group.sessions) {
      if (session.state === 'exited') continue;
      return session.id;
    }
  }
  return null;
}

function resolveSelection(
  navigator: SessionNavigatorModel,
  previousSelected: string | null,
  liveIds: Set<string>,
): string | null {
  if (previousSelected && liveIds.has(previousSelected)) return previousSelected;
  if (navigator.activeSessionId && liveIds.has(navigator.activeSessionId)) {
    return navigator.activeSessionId;
  }
  return firstLiveSessionId(navigator);
}

// "Live" here means currently selected and not the session that was just
// force-exited by a navigator update (selectedSessionId and exitedSessionId
// are never equal by construction, but the check documents the contract and
// stays correct if that invariant is ever revisited) — and not a session the
// navigator itself currently lists with state 'exited' (e.g. a directly
// selected sid that was never routed through applyNavigator's own fallback).
function isSessionExited(navigator: SessionNavigatorModel, sid: string): boolean {
  for (const group of navigator.groups) {
    for (const session of group.sessions) {
      if (session.id === sid) return session.state === 'exited';
    }
  }
  return false;
}

// Shared by `deriveInputEnabled` and the reconnect re-subscribe check
// below: a selected session id is "live" exactly when it is not the
// specific id a navigator update just force-cleared and the navigator does
// not (yet) list it as exited.
function isSelectionLive(
  navigator: SessionNavigatorModel,
  selectedSessionId: string,
  exitedSessionId: string | null,
): boolean {
  return selectedSessionId !== exitedSessionId && !isSessionExited(navigator, selectedSessionId);
}

function deriveInputEnabled(
  connection: PhoneConnectionStatus,
  selectedSessionId: string | null,
  exitedSessionId: string | null,
  navigator: SessionNavigatorModel,
): boolean {
  return (
    connection === 'connected' &&
    selectedSessionId !== null &&
    isSelectionLive(navigator, selectedSessionId, exitedSessionId)
  );
}

// Review issue 2 fix: `submitting` (and therefore the composer's Send
// disabled state) must reflect only the *selected* session's own pending
// submission — never whether some other, unselected session happens to have
// one in flight. `PhoneShell` calls this instead of ever reading
// `pendingSubmissions` directly, so there is exactly one place that derives
// "is the currently visible session's Send action in flight".
export function deriveSubmitting(
  selectedSessionId: string | null,
  pendingSubmissions: Record<string, PendingSubmission>,
): boolean {
  return selectedSessionId !== null && pendingSubmissions[selectedSessionId] !== undefined;
}

// Follow-up A fix: the composer's visible error must reflect only the
// *selected* session's own rejected/failed submission — never a stale error
// left behind by a different, no-longer-selected session. Mirrors
// `deriveSubmitting` immediately above: `PhoneShell` never reads
// `submissionErrors` directly, so there is exactly one place that derives
// "does the currently visible session have its own error to show".
export function deriveSubmissionError(
  selectedSessionId: string | null,
  submissionErrors: Record<string, string>,
): string | null {
  if (selectedSessionId === null) return null;
  return submissionErrors[selectedSessionId] ?? null;
}

// `update_required`/`authentication_failed` need re-pairing or an app update
// (never retryable). `closed` follows only an explicit, deliberate
// `client.close()` — not a transport failure — so it is not retryable
// through this client instance either. Every other status either already has
// the relay's own automatic reconnect loop driving it, or (`connection_error`)
// has stalled without one, hence a manual retry button.
function retryModeForStatus(status: PhoneConnectionStatus): RetryMode {
  if (status === 'authentication_failed' || status === 'update_required' || status === 'closed') {
    return 'blocked';
  }
  if (status === 'connection_error') return 'manual';
  return 'automatic';
}

function normalizeSubmitError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return typeof error === 'string' ? error : 'submission_failed';
}

function isRenderEffect(
  effect: TerminalSyncEffect,
): effect is Extract<TerminalSyncEffect, { type: 'reset' | 'write' }> {
  return effect.type === 'reset' || effect.type === 'write';
}

export function createMobileRemoteStore(
  client: RelayClient,
  options: MobileRemoteStoreOptions = {},
): StoreApi<MobileRemoteStore> {
  const createRequestId = options.requestId ?? (() => globalThis.crypto.randomUUID());

  // Monotonic per-store-instance render batch id. A new id is minted every
  // time a batch is (re)created — including when unconsumed effects are
  // merged with newly arrived ones — so a component keyed on `id` always
  // re-runs for genuinely new content and never re-applies a batch twice.
  let batchSequence = 0;
  function nextBatchId(): number {
    batchSequence += 1;
    return batchSequence;
  }

  // Guards `dispose()` itself, independent of whatever `client.onMessage`/
  // `onStatus` happen to return: two independent owners (e.g. a bootstrap
  // that created this store and a `<PhoneShell>` unmount) must never be
  // able to double-dispose, so idempotence is a contract of this store, not
  // an incidental property of the relay client's unsubscribe functions.
  let disposed = false;

  function sendSafely(message: MobileClientMessage): void {
    // Fire-and-forget commands (session.snapshot recovery requests,
    // discrete control keys): the relay already queues/rejects these
    // consistently, and a rejection here is not itself a user-facing draft
    // error, but an unhandled rejection must never leak.
    void client.send(message).catch(() => undefined);
  }

  const store = createStore<MobileRemoteStore>((set, get) => ({
    ...initialViewState(),

    setDraft(text) {
      const sid = get().selectedSessionId;
      if (!sid) return;
      set((state) => {
        const drafts = { ...state.drafts, [sid]: text };
        // Editing a sid's draft after a rejected/failed submission clears
        // only that sid's own stale error — the user is actively revising
        // this session's message, so the old alert no longer applies. A
        // different sid's own error (or lack of one) is never touched.
        if (!(sid in state.submissionErrors)) return { drafts };
        const { [sid]: _clearedError, ...remainingErrors } = state.submissionErrors;
        return { drafts, submissionErrors: remainingErrors };
      });
    },

    async submitDraft() {
      const state = get();
      const sid = state.selectedSessionId;
      const draft = sid ? state.drafts[sid] ?? '' : '';
      // Gated per sid, not globally: a different session's unacknowledged
      // submission must never block this one — only this exact sid already
      // having its own in-flight request does.
      if (!sid || !state.inputEnabled || !draft || state.pendingSubmissions[sid]) return;
      const requestId = createRequestId();
      set((current) => {
        const { [sid]: _clearedError, ...remainingErrors } = current.submissionErrors;
        return {
          pendingSubmissions: { ...current.pendingSubmissions, [sid]: { requestId, draft } },
          submissionErrors: remainingErrors,
        };
      });
      try {
        await client.send({ type: 'session.submit', sid, requestId, draft });
      } catch (error) {
        const current = get().pendingSubmissions[sid];
        if (!current || current.requestId !== requestId) {
          // This sid's entry was already cleared (e.g. by a connection
          // status change) or superseded by a newer submission for the same
          // session — a stale rejection must never clobber that state, and
          // is already scoped to this sid's own key so it can never touch a
          // different sid's entry.
          return;
        }
        set((s) => {
          const { [sid]: _removed, ...remaining } = s.pendingSubmissions;
          return {
            pendingSubmissions: remaining,
            submissionErrors: { ...s.submissionErrors, [sid]: normalizeSubmitError(error) },
          };
        });
      }
    },

    sendControl(data) {
      const state = get();
      if (!state.selectedSessionId || !state.inputEnabled) return;
      sendSafely({ type: 'session.input', sid: state.selectedSessionId, data });
    },

    selectSession(sid) {
      const state = get();
      set({
        selectedSessionId: sid,
        exitedSessionId: null,
        terminalSync: beginTerminalSync(sid),
        terminalBatch: null,
        drawerOpen: false,
        inputEnabled: deriveInputEnabled(state.connection, sid, null, state.navigator),
      });
      sendSafely({ type: 'session.snapshot', sid });
    },

    setDrawerOpen(open) {
      set({ drawerOpen: open });
    },

    retry() {
      if (get().retryMode !== 'manual') return;
      client.retry();
    },

    receive(message) {
      if (message.type === 'sessions.navigator') {
        applyNavigator(message.model);
        return;
      }
      if (message.type === 'session.snapshot') {
        applyTerminalResult(applyTerminalSnapshot(get().terminalSync, message));
        return;
      }
      if (message.type === 'pty.data') {
        applyTerminalResult(applyTerminalChunk(get().terminalSync, message));
        return;
      }
      if (message.type === 'session.submit.result') {
        applySubmitResult(message.sid, message.requestId, message.ok, message.error);
        return;
      }
      // `sessions.list` and `error` are outside this store's Task 3 contract
      // (navigator-driven selection supersedes the flat session list).
    },

    consumeTerminalBatch(id) {
      const current = get().terminalBatch;
      if (current && current.id === id) set({ terminalBatch: null });
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      offMessage();
      offStatus();
    },
  }));

  function applyNavigator(model: SessionNavigatorModel): void {
    const state = store.getState();
    const liveIds = collectLiveSessionIds(model);
    const nextSelected = resolveSelection(model, state.selectedSessionId, liveIds);

    if (nextSelected === state.selectedSessionId) {
      // Selection retained (including staying null) — refresh the navigator
      // and derived flags only. Do not restart terminal sync or resend a
      // snapshot for a routine (e.g. polling-driven) navigator refresh.
      store.setState({
        navigator: model,
        inputEnabled: deriveInputEnabled(state.connection, nextSelected, state.exitedSessionId, model),
      });
      return;
    }

    const exitedSessionId =
      state.selectedSessionId && !liveIds.has(state.selectedSessionId)
        ? state.selectedSessionId
        : state.exitedSessionId;

    if (nextSelected === null) {
      store.setState({
        navigator: model,
        selectedSessionId: null,
        exitedSessionId,
        terminalSync: emptyTerminalSync(),
        terminalBatch: null,
        inputEnabled: false,
      });
      return;
    }

    store.setState({
      navigator: model,
      selectedSessionId: nextSelected,
      exitedSessionId,
      terminalSync: beginTerminalSync(nextSelected),
      terminalBatch: null,
      drawerOpen: false,
      inputEnabled: deriveInputEnabled(state.connection, nextSelected, exitedSessionId, model),
    });
    sendSafely({ type: 'session.snapshot', sid: nextSelected });
  }

  function applyTerminalResult(result: {
    state: TerminalSyncState;
    effects: TerminalSyncEffect[];
  }): void {
    const state = store.getState();
    const renderEffects = result.effects.filter(isRenderEffect);
    const snapshotRequests = result.effects.filter(
      (effect): effect is Extract<TerminalSyncEffect, { type: 'requestSnapshot' }> =>
        effect.type === 'requestSnapshot',
    );

    const terminalBatch =
      renderEffects.length === 0
        ? state.terminalBatch
        : state.terminalBatch
          ? { id: nextBatchId(), effects: [...state.terminalBatch.effects, ...renderEffects] }
          : { id: nextBatchId(), effects: renderEffects };

    store.setState({ terminalSync: result.state, terminalBatch });

    for (const request of snapshotRequests) {
      sendSafely({ type: 'session.snapshot', sid: request.sid });
    }
  }

  function applySubmitResult(
    sid: string,
    requestId: string,
    ok: boolean,
    error: string | undefined,
  ): void {
    const state = store.getState();
    const pending = state.pendingSubmissions[sid];
    if (!pending || pending.requestId !== requestId) {
      // Stale or mismatched for this sid — never clear a different in-flight
      // submission (this sid's or any other sid's) or touch its draft. Since
      // lookup is keyed by `sid`, a result for one session can never reach,
      // clear, or overwrite another session's entry.
      return;
    }
    const { [sid]: _cleared, ...remainingPending } = state.pendingSubmissions;
    const { [sid]: _clearedError, ...remainingErrors } = state.submissionErrors;
    if (ok) {
      const currentDraft = state.drafts[sid] ?? '';
      const draftUntouchedSinceSend = currentDraft === pending.draft;
      store.setState({
        pendingSubmissions: remainingPending,
        submissionErrors: remainingErrors,
        drafts: draftUntouchedSinceSend ? { ...state.drafts, [sid]: '' } : state.drafts,
      });
      return;
    }
    store.setState({
      pendingSubmissions: remainingPending,
      submissionErrors: { ...remainingErrors, [sid]: error ?? 'submission_rejected' },
    });
  }

  const offMessage = client.onMessage((message) => {
    store.getState().receive(message);
  });
  const offStatus = client.onStatus((status) => {
    const state = store.getState();
    const reconnected = status === 'connected' && state.connection !== 'connected';
    store.setState({
      connection: status,
      retryMode: retryModeForStatus(status),
      inputEnabled: deriveInputEnabled(status, state.selectedSessionId, state.exitedSessionId, state.navigator),
      // Connection loss clears every session's in-flight submission (none
      // was ever queued for recovery) but every draft — sent or not, for
      // every session — is left untouched.
      pendingSubmissions: status === 'connected' ? state.pendingSubmissions : {},
    });

    // A freshly (re)established connection's desktop peer never fans out
    // live `pty.data` on its own: production
    // (`electron/remote/ptyFanout.ts`) only forwards it once a
    // `session.snapshot` request has recorded that peer's `subscribedSid`,
    // and a plain reconnect changes neither the navigator nor the phone's
    // own retained selection — so nothing else would ever send one, and
    // the terminal would otherwise freeze silently forever. So: exactly
    // once, only on a genuine not-connected -> connected transition (never
    // a duplicate `connected` while already connected), and only while the
    // retained selection is still live, restart terminal sync (so the
    // eventual snapshot reply is never rejected as stale by `lastSeq` —
    // see `terminalSync.ts`), drop any stale queued render batch, and
    // re-request the snapshot. This never touches drafts, focus, or
    // in-flight input/submission — an initial connect with nothing
    // selected yet simply has nothing to re-subscribe.
    if (reconnected && state.selectedSessionId !== null) {
      const sid = state.selectedSessionId;
      if (isSelectionLive(state.navigator, sid, state.exitedSessionId)) {
        store.setState({ terminalSync: beginTerminalSync(sid), terminalBatch: null });
        sendSafely({ type: 'session.snapshot', sid });
      }
    }
  });

  return store;
}
