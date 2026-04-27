// PR-N: ↑/↓ history recall on the composer.
//
// Contract under test (strict — must NOT trip during normal multi-line edits):
//   - ↑ on an exactly-empty composer fills the most recent user prompt.
//   - Repeated ↑ walks backwards; ↑ at the oldest prompt is a no-op.
//   - ↓ walks forward; ↓ at index 0 is a no-op (we never enter recall from
//     idle via ↓).
//   - ↓ from the most recent prompt clears the composer back to idle.
//   - ↑ on a non-empty composer (and not already in recall) does nothing —
//     the textarea handles it as a normal caret movement.
//   - Any user edit while in recall mode that diverges from the recalled
//     text exits recall mode (so the next ↑ restarts from the newest prompt).
//   - Switching sessionId resets the recall index.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { InputBar } from '../src/components/InputBar';
import { ToastProvider } from '../src/components/ui/Toast';
import { useStore } from '../src/stores/store';
import { clearDraft } from '../src/stores/drafts';
import type { MessageBlock } from '../src/types';

const initial = useStore.getState();

function freshStoreWithSession(
  sessionId: string,
  userTexts: string[] = [],
  opts: { running?: boolean; started?: boolean } = {}
) {
  const messages: MessageBlock[] = userTexts.map((text, i) => ({
    kind: 'user',
    id: `u-${sessionId}-${i}`,
    text,
  }));
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
      messagesBySession: { [sessionId]: messages },
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
    saveMessages: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
  // The drafts cache is module-singleton in-memory state; tests can leak
  // earlier `setDraft` calls into each other. Wipe both session ids we use.
  clearDraft('s-recall');
  clearDraft('s-other');
});

const SID = 's-recall';

function getTextarea(): HTMLTextAreaElement {
  return screen.getByRole('textbox') as HTMLTextAreaElement;
}

describe('InputBar: ↑/↓ history recall (PR-N)', () => {
  it('↑ on empty composer fills the most recent user prompt', () => {
    freshStoreWithSession(SID, ['first prompt', 'second prompt', 'third prompt'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    expect(ta.value).toBe('');
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('third prompt');
  });

  it('repeated ↑ walks backwards through history', () => {
    freshStoreWithSession(SID, ['first', 'second', 'third'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('third');
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('second');
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('first');
  });

  it('↑ at the oldest prompt is a no-op (stays put)', () => {
    freshStoreWithSession(SID, ['only one'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('only one');
    // Already at the top — another ↑ is swallowed but the value doesn't change.
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('only one');
  });

  it('↓ walks back toward the most recent prompt', () => {
    freshStoreWithSession(SID, ['first', 'second', 'third'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' }); // third
    fireEvent.keyDown(ta, { key: 'ArrowUp' }); // second
    fireEvent.keyDown(ta, { key: 'ArrowUp' }); // first
    fireEvent.keyDown(ta, { key: 'ArrowDown' }); // back to second
    expect(ta.value).toBe('second');
    fireEvent.keyDown(ta, { key: 'ArrowDown' }); // back to third
    expect(ta.value).toBe('third');
  });

  it('↓ from the most recent prompt clears the composer back to idle', () => {
    freshStoreWithSession(SID, ['first', 'second'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('second');
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    expect(ta.value).toBe('');
    // Now in idle — another ↓ is a no-op (textarea handles it normally).
    fireEvent.keyDown(ta, { key: 'ArrowDown' });
    expect(ta.value).toBe('');
  });

  it('↑ on a non-empty composer (not in recall) does NOT trigger recall', () => {
    freshStoreWithSession(SID, ['old prompt'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    // Simulate the user typing some draft.
    fireEvent.change(ta, { target: { value: 'draft\nmulti\nline' } });
    expect(ta.value).toBe('draft\nmulti\nline');
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    // Value unchanged — recall stayed dormant.
    expect(ta.value).toBe('draft\nmulti\nline');
  });

  it('typing while in recall exits recall mode (next ↑ restarts at newest)', () => {
    freshStoreWithSession(SID, ['first', 'second'], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' }); // second
    fireEvent.keyDown(ta, { key: 'ArrowUp' }); // first
    expect(ta.value).toBe('first');
    // User edits the recalled value — diverges from history[recallIndex-1].
    fireEvent.change(ta, { target: { value: 'first edited' } });
    expect(ta.value).toBe('first edited');
    // ↑ on a non-empty composer in idle mode is a no-op — the user's edit
    // dropped them out of recall, so this confirms the exit.
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('first edited');
    // Clear back to empty and ↑ should now start fresh from the newest prompt.
    fireEvent.change(ta, { target: { value: '' } });
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('second');
  });

  it('switching sessions resets the recall index', () => {
    freshStoreWithSession(SID, ['a1', 'a2'], { started: true });
    stubCCSM();
    const { rerender } = render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const taA = getTextarea();
    fireEvent.keyDown(taA, { key: 'ArrowUp' });
    fireEvent.keyDown(taA, { key: 'ArrowUp' });
    expect(taA.value).toBe('a1');

    // Mount the store with a second session and switch to it.
    act(() => {
      useStore.setState((s) => ({
        sessions: [
          ...s.sessions,
          {
            id: 's-other',
            name: 's-other',
            state: 'idle',
            cwd: '~',
            model: 'claude',
            groupId: 'g-default',
            agentType: 'claude-code',
          },
        ],
        messagesBySession: {
          ...s.messagesBySession,
          ['s-other']: [{ kind: 'user', id: 'u-o-0', text: 'b1' }],
        },
        startedSessions: { ...s.startedSessions, ['s-other']: true },
        activeId: 's-other',
      }));
    });
    rerender(<ToastProvider><InputBar sessionId={'s-other'} /></ToastProvider>);
    const taB = getTextarea();
    expect(taB.value).toBe('');
    // Recall index reset — first ↑ in the new session pulls the new session's
    // newest prompt, not whatever index we were at in the previous session.
    fireEvent.keyDown(taB, { key: 'ArrowUp' });
    expect(taB.value).toBe('b1');
  });

  it('ignores empty / whitespace-only past prompts', () => {
    freshStoreWithSession(SID, ['real prompt', '   ', ''], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('real prompt');
  });

  it('does nothing when there is no user history at all', () => {
    freshStoreWithSession(SID, [], { started: true });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = getTextarea();
    fireEvent.keyDown(ta, { key: 'ArrowUp' });
    expect(ta.value).toBe('');
  });
});
