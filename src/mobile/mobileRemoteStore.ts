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
  sid: string;
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
  pendingSubmission: PendingSubmission | null;
  submissionError: string | null;
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
    pendingSubmission: null,
    submissionError: null,
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

function deriveInputEnabled(
  connection: PhoneConnectionStatus,
  selectedSessionId: string | null,
  exitedSessionId: string | null,
  navigator: SessionNavigatorModel,
): boolean {
  return (
    connection === 'connected' &&
    selectedSessionId !== null &&
    selectedSessionId !== exitedSessionId &&
    !isSessionExited(navigator, selectedSessionId)
  );
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
      set((state) => ({ drafts: { ...state.drafts, [sid]: text } }));
    },

    async submitDraft() {
      const state = get();
      const sid = state.selectedSessionId;
      const draft = sid ? state.drafts[sid] ?? '' : '';
      if (!sid || !state.inputEnabled || !draft || state.pendingSubmission) return;
      const requestId = createRequestId();
      set({ pendingSubmission: { sid, requestId, draft }, submissionError: null });
      try {
        await client.send({ type: 'session.submit', sid, requestId, draft });
      } catch (error) {
        const current = get().pendingSubmission;
        if (!current || current.sid !== sid || current.requestId !== requestId) {
          // The pending submission this rejection belongs to was already
          // cleared (e.g. by a connection status change) or superseded by a
          // newer submission for the same session — a stale rejection must
          // never clobber that state or surface a phantom error.
          return;
        }
        set({ pendingSubmission: null, submissionError: normalizeSubmitError(error) });
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
    const pending = state.pendingSubmission;
    if (!pending || pending.sid !== sid || pending.requestId !== requestId) {
      // Stale or mismatched — never clear a different in-flight submission or
      // touch its draft.
      return;
    }
    if (ok) {
      const currentDraft = state.drafts[sid] ?? '';
      const draftUntouchedSinceSend = currentDraft === pending.draft;
      store.setState({
        pendingSubmission: null,
        submissionError: null,
        drafts: draftUntouchedSinceSend ? { ...state.drafts, [sid]: '' } : state.drafts,
      });
      return;
    }
    store.setState({ pendingSubmission: null, submissionError: error ?? 'submission_rejected' });
  }

  const offMessage = client.onMessage((message) => {
    store.getState().receive(message);
  });
  const offStatus = client.onStatus((status) => {
    const state = store.getState();
    store.setState({
      connection: status,
      retryMode: retryModeForStatus(status),
      inputEnabled: deriveInputEnabled(status, state.selectedSessionId, state.exitedSessionId, state.navigator),
      // Connection loss clears any in-flight submission (it was never queued
      // for recovery) but every draft — sent or not — is left untouched.
      pendingSubmission: status === 'connected' ? state.pendingSubmission : null,
    });
  });

  return store;
}
