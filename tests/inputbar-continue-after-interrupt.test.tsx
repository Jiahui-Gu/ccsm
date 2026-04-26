// InputBar wiring for #322 continue-after-interrupt affordance.
//
// Asserts the contract between `lastTurnEnd` (in-store) and the InputBar's
// post-stop hint:
//   1. After markInterrupted, the hint row appears above the composer when
//      the textarea is empty + agent is idle.
//   2. Typing any char hides the hint (latches dismissed even if the user
//      backspaces back to empty).
//   3. Pressing Enter while the hint is visible + textarea empty sends the
//      literal `continue` through the normal send path.
//   4. A fresh interrupt re-arms the hint after a previous send.
//
// Stubs `window.ccsm.agentSend` to capture the payload the IPC bridge would
// receive — same edge the real agent process sees.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { InputBar } from '../src/components/InputBar';
import { useStore } from '../src/stores/store';
import { ToastProvider } from '../src/components/ui/Toast';

const initial = useStore.getState();

// PR #359 added a `useToast()` call in InputBar; renders need ToastProvider.
function renderInputBar(sessionId: string) {
  return render(
    <ToastProvider>
      <InputBar sessionId={sessionId} />
    </ToastProvider>
  );
}

function freshStoreWithSession(
  sessionId: string,
  opts: { running?: boolean; started?: boolean } = {}
) {
  useStore.setState(
    {
      ...initial,
      sessions: [
        {
          id: sessionId,
          name: sessionId,
          state: 'idle',
          cwd: '~',
          model: 'claude',
          groupId: 'g-default',
          agentType: 'claude-code',
        },
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: sessionId,
      messagesBySession: {},
      startedSessions: opts.started ? { [sessionId]: true } : {},
      runningSessions: opts.running ? { [sessionId]: true } : {},
      messageQueues: {},
      pendingDiffComments: {},
      lastTurnEnd: {},
      interruptedSessions: {},
      focusInputNonce: 0,
    },
    true
  );
}

function stubCCSM(overrides: Partial<Record<string, unknown>> = {}) {
  const api = {
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentSend: vi.fn().mockResolvedValue(true),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentStart: vi.fn().mockResolvedValue({ ok: true }),
    loadHistory: vi.fn().mockResolvedValue({ ok: true, frames: [] }),
    ...overrides,
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

const SID = 's-322';
const HINT_TID = 'continue-after-interrupt-hint';

describe('InputBar: continue-after-interrupt hint (#322)', () => {
  it('does not show the hint when the last turn has not been interrupted', () => {
    freshStoreWithSession(SID, { started: true });
    stubCCSM();
    renderInputBar(SID);
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
  });

  it('shows the hint after markInterrupted while composer is empty + agent idle', () => {
    freshStoreWithSession(SID, { started: true });
    stubCCSM();
    renderInputBar(SID);
    act(() => {
      useStore.getState().markInterrupted(SID);
    });
    expect(screen.getByTestId(HINT_TID)).toBeInTheDocument();
    // Sanity: the store recorded the disposition the hint reads from.
    expect(useStore.getState().lastTurnEnd[SID]).toBe('interrupted');
  });

  it('hides the hint as soon as the user types a character', () => {
    freshStoreWithSession(SID, { started: true });
    stubCCSM();
    renderInputBar(SID);
    act(() => {
      useStore.getState().markInterrupted(SID);
    });
    expect(screen.getByTestId(HINT_TID)).toBeInTheDocument();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'h' } });
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
    // Backspacing to empty does NOT re-show — the typed-since-interrupt latch
    // stays dismissed until a fresh interrupt arrives.
    fireEvent.change(ta, { target: { value: '' } });
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
  });

  it('sends the literal `continue` when the hint is visible and Enter is pressed on empty composer', async () => {
    freshStoreWithSession(SID, { started: true });
    const api = stubCCSM();
    renderInputBar(SID);
    act(() => {
      useStore.getState().markInterrupted(SID);
    });
    const ta = screen.getByRole('textbox');
    expect(screen.getByTestId(HINT_TID)).toBeInTheDocument();
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(api.agentSend).toHaveBeenCalledTimes(1);
    expect(api.agentSend).toHaveBeenCalledWith(SID, 'continue');
    // Hint dismisses synchronously on send.
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
    expect(useStore.getState().lastTurnEnd[SID]).toBeUndefined();
  });

  it('does not show the hint when the agent is currently running', () => {
    freshStoreWithSession(SID, { started: true, running: true });
    stubCCSM();
    renderInputBar(SID);
    // Even if some prior turn was marked interrupted, a running session is
    // not an "interrupted, awaiting continue" state.
    act(() => {
      useStore.setState((s) => ({ lastTurnEnd: { ...s.lastTurnEnd, [SID]: 'interrupted' as const } }));
    });
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
  });

  it('re-arms after a fresh interrupt following a normal send', async () => {
    freshStoreWithSession(SID, { started: true });
    const api = stubCCSM();
    renderInputBar(SID);
    act(() => {
      useStore.getState().markInterrupted(SID);
    });
    expect(screen.getByTestId(HINT_TID)).toBeInTheDocument();
    // Type + send a real message — hint hides because typed-since-interrupt
    // latched, and lastTurnEnd is cleared in send().
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'something else' } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(api.agentSend).toHaveBeenLastCalledWith(SID, 'something else');
    expect(screen.queryByTestId(HINT_TID)).toBeNull();
    // Simulate the agent finishing the turn (lifecycle would call
    // setRunning(false) on the result frame), then a fresh interrupt on the
    // next turn. The hint should re-arm with the typed-since-interrupt latch
    // reset.
    act(() => {
      useStore.getState().setRunning(SID, false);
      useStore.getState().markInterrupted(SID);
    });
    expect(screen.getByTestId(HINT_TID)).toBeInTheDocument();
  });
});
