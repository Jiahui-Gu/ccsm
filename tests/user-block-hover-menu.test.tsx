// Component tests for the user-message hover menu (Edit / Retry / Copy /
// Rewind from here). The menu is the surfaced equivalent of upstream's
// per-user-message popup (webview/index.js → Oo1) but uses the verbs CCSM
// users actually asked for — see UserBlock.tsx for the rationale.
//
// Tests render <UserBlock /> against the real Zustand store and stub
// `window.ccsm` + `navigator.clipboard` to capture side effects. The four
// click tests are the spec the worker prompt called out; rewind has its own
// truncation assertion since it's the only action that mutates other blocks.
import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { UserBlock } from '../src/components/chat/blocks/UserBlock';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

function freshStoreWithSession(sessionId: string, blocks: Array<Parameters<typeof useStore.getState>[0] extends void ? never : never> | unknown[] = []) {
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
          agentType: 'claude-code'
        }
      ],
      groups: [{ id: 'g-default', name: 'Sessions', collapsed: false, kind: 'normal' }],
      activeId: sessionId,
      messagesBySession: { [sessionId]: blocks as never },
      startedSessions: { [sessionId]: true },
      runningSessions: {},
      messageQueues: {},
      focusInputNonce: 0,
      composerInjectNonce: 0,
      composerInjectText: ''
    },
    true
  );
}

function stubCCSM(overrides: Partial<Record<string, unknown>> = {}) {
  const api = {
    agentSend: vi.fn().mockResolvedValue(true),
    agentSendContent: vi.fn().mockResolvedValue(true),
    agentInterrupt: vi.fn().mockResolvedValue(undefined),
    agentClose: vi.fn().mockResolvedValue(true),
    ...overrides
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

function setClipboard() {
  const writeText = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', {
    value: { writeText },
    configurable: true,
    writable: true
  });
  return writeText;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('<UserBlock /> hover menu', () => {
  it('renders all four action buttons (Edit / Retry / Copy / Rewind)', () => {
    freshStoreWithSession('s1');
    stubCCSM();
    render(<UserBlock id="u1" text="hello" sessionId="s1" />);
    // The buttons are always in the DOM — opacity-0 by default, opacity-100
    // on group-hover. We don't assert visibility because jsdom doesn't apply
    // tailwind's group-hover; the probe covers the visual side.
    expect(screen.getByRole('button', { name: /edit and resend/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^retry$/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /copy message/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /rewind from here/i })).toBeInTheDocument();
  });

  it('Copy: writes the message text to the clipboard and flips to "Copied"', async () => {
    freshStoreWithSession('s1');
    stubCCSM();
    const writeText = setClipboard();
    render(<UserBlock id="u1" text="please refactor this" sessionId="s1" />);
    const btn = screen.getByRole('button', { name: /copy message/i });
    await act(async () => {
      fireEvent.click(btn);
    });
    expect(writeText).toHaveBeenCalledWith('please refactor this');
    // Tooltip + aria-label flip together via the `copied` state.
    expect(screen.getByRole('button', { name: /^copied$/i })).toHaveAttribute('data-copied', 'true');
  });

  it('Edit: bumps composerInjectNonce and stages the original text in the store', () => {
    freshStoreWithSession('s1');
    stubCCSM();
    const before = useStore.getState().composerInjectNonce;
    render(<UserBlock id="u1" text="my original prompt" sessionId="s1" />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /edit and resend/i }));
    });
    const after = useStore.getState();
    expect(after.composerInjectNonce).toBe(before + 1);
    expect(after.composerInjectText).toBe('my original prompt');
  });

  it('Retry: appends a new user echo block and dispatches agentSend with the same text', async () => {
    const blocks = [{ kind: 'user' as const, id: 'u1', text: 'do the thing' }];
    freshStoreWithSession('s1', blocks);
    const api = stubCCSM();
    render(<UserBlock id="u1" text="do the thing" sessionId="s1" />);
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^retry$/i }));
    });
    expect(api.agentSend).toHaveBeenCalledWith('s1', 'do the thing');
    const after = useStore.getState().messagesBySession['s1'] ?? [];
    // Original block is preserved (Retry is non-destructive); the echo is the
    // SECOND user block now.
    const userBlocks = after.filter((b) => b.kind === 'user');
    expect(userBlocks).toHaveLength(2);
    expect(userBlocks[1].text).toBe('do the thing');
    expect(useStore.getState().runningSessions['s1']).toBe(true);
  });

  it('Rewind from here: truncates the conversation to before this block, drops resumeSessionId, calls agentClose', () => {
    const blocks = [
      { kind: 'assistant' as const, id: 'a0', text: 'previous reply' },
      { kind: 'user' as const, id: 'u1', text: 'this one' },
      { kind: 'assistant' as const, id: 'a1', text: 'reply to u1' },
      { kind: 'tool' as const, id: 't1', name: 'Read', brief: 'foo', expanded: false }
    ];
    freshStoreWithSession('s1', blocks);
    // Pin a resumeSessionId so we can verify it's dropped.
    useStore.setState((s) => ({
      sessions: s.sessions.map((x) =>
        x.id === 's1' ? { ...x, resumeSessionId: 'old-claude-uuid' } : x
      )
    }));
    const api = stubCCSM();
    render(<UserBlock id="u1" text="this one" sessionId="s1" />);
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: /rewind from here/i }));
    });
    const after = useStore.getState();
    expect(after.messagesBySession['s1']).toHaveLength(1);
    expect(after.messagesBySession['s1'][0].id).toBe('a0');
    const sess = after.sessions.find((x) => x.id === 's1');
    expect(sess?.resumeSessionId).toBeUndefined();
    expect(after.startedSessions['s1']).toBeFalsy();
    expect(api.agentClose).toHaveBeenCalledWith('s1');
  });
});
