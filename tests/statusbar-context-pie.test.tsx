// Component tests for the StatusBar context-usage pie chip (PR-R, Task #42).
//
// Behavior under test:
//  1. Below 50% the chip stays hidden — keeps the StatusBar quiet on
//     every-day turns where /compact isn't relevant.
//  2. At 50–79% the chip surfaces with a neutral tone.
//  3. At 80–94% the tone bumps to amber (state-warning).
//  4. At ≥95% the tone bumps to red (state-error).
//  5. Clicking the chip dispatches "/compact" through agentSend, matching the
//     official VS Code Claude extension's auto-compact CTA. We assert the
//     *raw* slash command — claude.exe handles /compact natively, ccsm does
//     not need its own client-side handler.
//
// We render <StatusBar /> against the real Zustand store and stub
// `window.ccsm.agentSend`. The store path that lifecycle.ts uses to push
// usage snapshots is `setSessionContextUsage` — calling it here keeps the
// test focused on the chip rather than re-exercising stream parsing.

import React from 'react';
import { describe, it, expect, beforeEach, vi, cleanup as _unused } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { StatusBar } from '../src/components/StatusBar';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

const SESSION_ID = 's-pie';

function setupStore(usage?: { totalTokens: number; contextWindow: number; model: string }) {
  useStore.setState(
    {
      ...initial,
      sessions: [
        {
          id: SESSION_ID,
          name: SESSION_ID,
          state: 'idle',
          cwd: '/tmp',
          model: 'claude-sonnet-4-5',
          groupId: 'g-default',
          agentType: 'claude-code'
        }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: SESSION_ID,
      contextUsageBySession: usage ? { [SESSION_ID]: usage } : {},
      // ChipMenu binds to this; without a clean reset a leftover popoverId
      // from a sibling test could leave a menu inadvertently open.
      openPopoverId: null
    },
    true
  );
}

function stubCCSM() {
  const api = {
    agentSend: vi.fn().mockResolvedValue(true),
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentStart: vi.fn().mockResolvedValue({ ok: true })
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

function renderBar() {
  return render(
    <StatusBar
      cwd="/tmp"
      sessionId={SESSION_ID}
      model="claude-sonnet-4-5"
      permission="default"
      onChangeCwdToPath={() => {}}
      onBrowseForCwd={() => {}}
      onChangeModel={() => {}}
      onChangePermission={() => {}}
    />
  );
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

describe('<StatusBar /> context-pie chip', () => {
  it('stays hidden below the 50% display threshold', () => {
    setupStore({ totalTokens: 60_000, contextWindow: 200_000, model: 'claude-sonnet-4-5' });
    stubCCSM();
    renderBar();
    expect(screen.queryByTestId('context-pie-chip')).toBeNull();
  });

  it('stays hidden when the model has not reported a context window yet', () => {
    // First-turn-before-result race: usage snapshot exists with totalTokens
    // but contextWindow is null (older CLI / error frame). We refuse to
    // hardcode 200_000 as a fallback — the chip just stays hidden.
    setupStore({ totalTokens: 180_000, contextWindow: 0, model: 'claude-sonnet-4-5' });
    stubCCSM();
    renderBar();
    expect(screen.queryByTestId('context-pie-chip')).toBeNull();
  });

  it('shows with a neutral tone at 70%', () => {
    setupStore({ totalTokens: 140_000, contextWindow: 200_000, model: 'claude-sonnet-4-5' });
    stubCCSM();
    renderBar();
    const chip = screen.getByTestId('context-pie-chip');
    expect(chip).toBeInTheDocument();
    expect(chip).toHaveAttribute('data-percent', '70');
    expect(chip).toHaveAttribute('data-tone', 'neutral');
    expect(chip.textContent).toContain('70%');
  });

  it('upgrades to the amber warning tone at 90%', () => {
    setupStore({ totalTokens: 180_000, contextWindow: 200_000, model: 'claude-sonnet-4-5' });
    stubCCSM();
    renderBar();
    const chip = screen.getByTestId('context-pie-chip');
    expect(chip).toHaveAttribute('data-tone', 'warning');
    expect(chip).toHaveAttribute('data-percent', '90');
  });

  it('upgrades to the red error tone at 95%+', () => {
    setupStore({ totalTokens: 192_000, contextWindow: 200_000, model: 'claude-sonnet-4-5' });
    stubCCSM();
    renderBar();
    const chip = screen.getByTestId('context-pie-chip');
    expect(chip).toHaveAttribute('data-tone', 'error');
    expect(chip).toHaveAttribute('data-percent', '96');
  });

  it('dispatches "/compact" via agentSend on click', () => {
    setupStore({ totalTokens: 180_000, contextWindow: 200_000, model: 'claude-sonnet-4-5' });
    const api = stubCCSM();
    renderBar();
    const chip = screen.getByTestId('context-pie-chip');
    act(() => {
      fireEvent.click(chip);
    });
    expect(api.agentSend).toHaveBeenCalledTimes(1);
    expect(api.agentSend).toHaveBeenCalledWith(SESSION_ID, '/compact');
  });
});
