// Phone shell root component (mobile composer/terminal-sync plan, Task 5).
// Wires one `createMobileRemoteStore(client)` instance to the top bar,
// connection banner, shared session drawer, read-only terminal, discrete
// key bar, and composer.
//
// Final user override (supersedes any older focus-management text
// elsewhere in the plan): nothing in this component ever calls `focus()`
// or `blur()` on the composer, terminal, drawer controls, or menu button,
// and nothing here parses terminal output to infer "is a question being
// asked" or "is the keyboard open" — AskUserQuestion free text is just a
// normal composer submission over the native PTY, and the visual-viewport
// CSS custom properties the adapter maintains are what keep the shell
// pinned to the visible viewport, not any JS-side keyboard-state guess.

import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { StoreApi } from 'zustand/vanilla';

import { MessageComposer } from './MessageComposer';
import { TerminalKeyBar } from './TerminalKeyBar';
import { SessionDrawer } from './SessionDrawer';
import { MobileTerminal, type MobileTerminalAdapterFactory } from './MobileTerminal';
import { createMobileRemoteStore, type MobileRemoteStore } from '../mobileRemoteStore';
import type { PhoneConnectionStatus, RelayClient } from '../relayClient';
import type { MobileTerminalAdapter } from '../mobileTerminalAdapter';
import type { SessionNavigatorModel } from '../../shared/sessionNavigator';

export type PhoneShellProps = {
  client: RelayClient;
  // Test/DI seams — both default to the real production implementations,
  // so `<PhoneShell client={client} />` remains the whole production API.
  createStore?: (client: RelayClient) => StoreApi<MobileRemoteStore>;
  createAdapter?: MobileTerminalAdapterFactory;
};

const STATUS_COPY: Record<PhoneConnectionStatus, string> = {
  connecting: 'Connecting…',
  authenticating: 'Authenticating…',
  connected: 'Connected',
  reconnecting: 'Reconnecting…',
  update_required: 'Update required: this app version can no longer talk to your desktop.',
  authentication_failed: 'Authentication failed. Re-pair this device from the desktop app.',
  connection_error: 'Connection lost.',
  closed: 'Disconnected.',
};

type SessionInfo = { name: string; groupName: string; cwd: string } | null;

function findSessionInfo(navigator: SessionNavigatorModel, sid: string | null): SessionInfo {
  if (!sid) return null;
  for (const group of navigator.groups) {
    for (const session of group.sessions) {
      if (session.id === sid) return { name: session.name, groupName: group.name, cwd: session.cwd };
    }
  }
  return null;
}

export function PhoneShell({
  client,
  createStore = createMobileRemoteStore,
  createAdapter,
}: PhoneShellProps) {
  const store = useMemo(() => createStore(client), [client, createStore]);
  const state = useSyncExternalStore(store.subscribe, store.getState, store.getState);
  const adapterRef = useRef<MobileTerminalAdapter | null>(null);

  useEffect(() => {
    return () => store.getState().dispose();
  }, [store]);

  // Stable identity across re-renders: reads fresh state via `store.getState()`
  // inside the callback body instead of depending on the reactive `state`
  // value, so `MobileTerminal` never recreates the adapter just because the
  // store emitted an unrelated update.
  const handleResize = useCallback(
    (dimensions: { cols: number; rows: number }) => {
      const current = store.getState();
      if (!current.selectedSessionId || !current.inputEnabled) return;
      void client
        .send({ type: 'session.resize', sid: current.selectedSessionId, cols: dimensions.cols, rows: dimensions.rows })
        .catch(() => undefined);
    },
    [client, store],
  );

  const handleConsumed = useCallback(
    (id: number) => {
      store.getState().consumeTerminalBatch(id);
    },
    [store],
  );

  // Force a resize emission at the new session's PTY, even if the terminal
  // element's own on-screen dimensions happen not to have changed — a
  // different session is a different backing PTY that needs its own
  // dimensions applied, not just a cosmetic no-op.
  useEffect(() => {
    if (!state.selectedSessionId) return;
    adapterRef.current?.fit(true);
  }, [state.selectedSessionId]);

  const sessionInfo = findSessionInfo(state.navigator, state.selectedSessionId);
  const draft = state.selectedSessionId ? state.drafts[state.selectedSessionId] ?? '' : '';
  const submitting = state.pendingSubmission !== null;
  const showBanner = state.connection !== 'connected';

  function handleDraftChange(text: string): void {
    store.getState().setDraft(text);
  }

  function handleSubmit(): void {
    void store.getState().submitDraft();
  }

  function handleControl(data: string): void {
    store.getState().sendControl(data);
  }

  function handleOpenDrawer(): void {
    store.getState().setDrawerOpen(true);
  }

  function handleCloseDrawer(): void {
    store.getState().setDrawerOpen(false);
  }

  function handleSelectSession(sid: string): void {
    store.getState().selectSession(sid);
  }

  function handleRetry(): void {
    store.getState().retry();
  }

  return (
    <div className="phone-shell">
      <header className="phone-topbar">
        <button
          type="button"
          className="phone-topbar__menu"
          aria-label="Sessions menu"
          aria-expanded={state.drawerOpen}
          aria-controls="phone-session-drawer"
          onClick={handleOpenDrawer}
        >
          ☰
        </button>
        <div className="phone-topbar__session">
          {sessionInfo ? (
            <>
              <span className="phone-topbar__name">{sessionInfo.name}</span>
              <span className="phone-topbar__group">{sessionInfo.groupName}</span>
              <span className="phone-topbar__cwd">{sessionInfo.cwd}</span>
            </>
          ) : (
            <span className="phone-topbar__name">No session</span>
          )}
        </div>
        <span className="phone-topbar__connection" data-connection={state.connection}>
          {STATUS_COPY[state.connection]}
        </span>
      </header>

      {showBanner ? (
        <div className="phone-banner" role="status">
          <span>{STATUS_COPY[state.connection]}</span>
          {state.retryMode === 'manual' ? (
            <button type="button" className="phone-banner__retry" onClick={handleRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      <SessionDrawer
        open={state.drawerOpen}
        model={state.navigator}
        selectedSessionId={state.selectedSessionId}
        onClose={handleCloseDrawer}
        onSelectSession={handleSelectSession}
      />

      <MobileTerminal
        batch={state.terminalBatch}
        onResize={handleResize}
        onConsumed={handleConsumed}
        adapterRef={adapterRef}
        createAdapter={createAdapter}
      />

      <div className="phone-controls">
        <TerminalKeyBar enabled={state.inputEnabled} onInput={handleControl} />
        <MessageComposer
          draft={draft}
          enabled={state.inputEnabled}
          submitting={submitting}
          error={state.submissionError}
          onDraftChange={handleDraftChange}
          onSubmit={handleSubmit}
        />
      </div>
    </div>
  );
}
