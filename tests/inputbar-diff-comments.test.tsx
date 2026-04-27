// InputBar wiring for #303 per-line diff comments.
//
// Asserts the contract between `pendingDiffComments` (in-store) and the
// outgoing user prompt:
//   1. With no pending comments, send() forwards the raw text unchanged.
//   2. With pending comments, send() prepends `<diff-feedback>` blocks
//      followed by a blank line, then clears the comments from the store.
//   3. While the agent is running, the same prepend is baked into the
//      QUEUED message (so the comment travels with the exact user turn the
//      author was looking at when they pressed Enter, even if the queue
//      drains many seconds later).
//   4. The pending-comments indicator chip surfaces the count and disappears
//      after send.
//
// Stubs `window.ccsm.agentSend` to capture the payload the IPC bridge
// would receive — this is the same edge the real agent process sees.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { InputBar } from '../src/components/InputBar';
import { ToastProvider } from '../src/components/ui/Toast';
import { useStore } from '../src/stores/store';

const initial = useStore.getState();

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
    ...overrides,
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

const SID = 's-303';

describe('InputBar: diff-comment prepend on send', () => {
  it('forwards the raw text unchanged when there are no pending comments', async () => {
    freshStoreWithSession(SID, { started: true });
    const api = stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'hello' } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' });
      // Let the async send() resolve.
      await Promise.resolve();
    });
    expect(api.agentSend).toHaveBeenCalledTimes(1);
    expect(api.agentSend).toHaveBeenCalledWith(SID, 'hello');
  });

  it('prepends one <diff-feedback> per pending comment, then clears them', async () => {
    freshStoreWithSession(SID, { started: true });
    act(() => {
      useStore.getState().addDiffComment(SID, { file: '/a/x.ts', line: 0, text: 'use X' });
      useStore.getState().addDiffComment(SID, { file: '/a/x.ts', line: 3, text: 'rename Y' });
    });
    const api = stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'fix it' } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(api.agentSend).toHaveBeenCalledTimes(1);
    const [, payload] = api.agentSend.mock.calls[0];
    // Exact format: each block on its own line, then blank line, then user text.
    expect(payload).toBe(
      '<diff-feedback file="/a/x.ts" line="0">use X</diff-feedback>\n' +
      '<diff-feedback file="/a/x.ts" line="3">rename Y</diff-feedback>\n' +
      '\n' +
      'fix it'
    );
    // Comments are consumed — second send must NOT re-prepend.
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('bakes the prepend into the QUEUED message when the agent is running', () => {
    // Started + running — Enter should enqueue, not call agentSend.
    freshStoreWithSession(SID, { started: true, running: true });
    act(() => {
      useStore.getState().addDiffComment(SID, { file: '/q.ts', line: 1, text: 'less code' });
    });
    const api = stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'follow-up' } });
    act(() => {
      fireEvent.keyDown(ta, { key: 'Enter' });
    });
    // No IPC fired — message went into the queue.
    expect(api.agentSend).not.toHaveBeenCalled();
    const queue = useStore.getState().messageQueues[SID];
    expect(queue).toHaveLength(1);
    // Queued payload carries the full prepend so the eventual drain sends
    // exactly what the user expected at Enter time.
    expect(queue![0].text).toBe(
      '<diff-feedback file="/q.ts" line="1">less code</diff-feedback>\n\nfollow-up'
    );
    // Comments cleared synchronously on enqueue.
    expect(useStore.getState().pendingDiffComments[SID]).toBeUndefined();
  });

  it('renders the "{n} diff comments will be sent" indicator and hides it after send', async () => {
    freshStoreWithSession(SID, { started: true });
    act(() => {
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 0, text: 'a' });
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 1, text: 'b' });
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 2, text: 'c' });
    });
    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    expect(screen.getByText(/3 diff comments will be sent/i)).toBeInTheDocument();
    const ta = screen.getByRole('textbox');
    fireEvent.change(ta, { target: { value: 'go' } });
    await act(async () => {
      fireEvent.keyDown(ta, { key: 'Enter' });
      await Promise.resolve();
    });
    expect(screen.queryByText(/diff comments will be sent/i)).toBeNull();
  });

  it('clicking the indicator scrolls the FIRST pending comment (smallest line) into view', () => {
    freshStoreWithSession(SID, { started: true });
    // Add comments out of order — the indicator must still scroll the
    // smallest-line one (matches serializeDiffCommentsForPrompt order).
    act(() => {
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 5, text: 'fifth' });
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 1, text: 'first' });
      useStore.getState().addDiffComment(SID, { file: '/a.ts', line: 3, text: 'third' });
    });
    // Resolve the comment ids the way the click handler will: by walking the
    // store and picking (file asc, line asc, createdAt asc).
    const bucket = useStore.getState().pendingDiffComments[SID]!;
    const sorted = Object.values(bucket).sort((a, b) => a.line - b.line);
    const firstId = sorted[0].id;

    // Mount fake chip elements representing the rendered DiffView. We mount
    // them in DOM order DIFFERENT from line order so a naive
    // `querySelector('[data-diff-comment-chip]')` would pick the wrong one.
    const wrap = document.createElement('div');
    sorted
      .slice()
      .reverse()
      .forEach((c) => {
        const chip = document.createElement('button');
        chip.setAttribute('data-diff-comment-chip', '');
        chip.setAttribute('data-diff-comment-id', c.id);
        wrap.appendChild(chip);
      });
    document.body.appendChild(wrap);
    const firstEl = wrap.querySelector(
      `[data-diff-comment-id="${firstId}"]`
    ) as HTMLElement;
    const scrollSpy = vi.fn();
    firstEl.scrollIntoView = scrollSpy as unknown as Element['scrollIntoView'];

    stubCCSM();
    render(<ToastProvider><InputBar sessionId={SID} /></ToastProvider>);
    const indicator = screen.getByText(/3 diff comments will be sent/i);
    fireEvent.click(indicator);
    expect(scrollSpy).toHaveBeenCalledTimes(1);
    expect(scrollSpy).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });

    document.body.removeChild(wrap);
  });
});
