// Component tests for InputBar focused on the CLI-style affordances:
//  - Esc-to-interrupt fires `agentInterrupt` while running and is silent otherwise
//  - Send-while-running enqueues into the per-session FIFO instead of dispatching
//  - Stop clears the queue (matches CLI Ctrl+C dropping pending input)
//  - The +N queued chip surfaces queue depth
//
// We render <InputBar /> against the real Zustand store and stub `window.ccsm`
// to capture IPC calls. This is intentionally not a probe — we want fast feedback
// on the keyboard plumbing without spinning up Electron.
import React from 'react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';
import { InputBar } from '../src/components/InputBar';
import { useStore } from '../src/stores/store';
import { ToastProvider } from '../src/components/ui/Toast';

const initial = useStore.getState();

// PR #359 added a `useToast()` call in InputBar; component renders now
// require a ToastProvider in the tree. Wrap once here so individual cases
// can keep using bare <InputBar /> JSX.
function renderWithProviders(sessionId: string) {
  return render(
    <ToastProvider>
      <InputBar sessionId={sessionId} />
    </ToastProvider>
  );
}

function freshStoreWithSession(sessionId: string, opts: { running?: boolean; started?: boolean } = {}) {
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
      messagesBySession: {},
      startedSessions: opts.started ? { [sessionId]: true } : {},
      runningSessions: opts.running ? { [sessionId]: true } : {},
      messageQueues: {},
      focusInputNonce: 0
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
    ...overrides
  };
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = api;
  return api;
}

beforeEach(() => {
  cleanup();
  (globalThis as unknown as { window: Window & { ccsm?: unknown } }).window.ccsm = undefined;
});

describe('InputBar: Esc to interrupt running turn', () => {
  it('Esc fires agentInterrupt when the session is running', () => {
    freshStoreWithSession('s-esc', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-esc");
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-esc');
    // markInterrupted side-effect — verifies stop() ran the full sequence.
    expect(useStore.getState().interruptedSessions['s-esc']).toBe(true);
  });

  it('Esc is a no-op when the session is NOT running', () => {
    freshStoreWithSession('s-idle', { running: false, started: true });
    const api = stubCCSM();
    renderWithProviders("s-idle");
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).not.toHaveBeenCalled();
  });

  it('Esc yields to an open modal dialog (lets the dialog close itself)', () => {
    freshStoreWithSession('s-modal', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-modal");
    // Inject a fake modal dialog — the global handler must back off when one
    // is present so settings/command-palette Esc-to-close still works. Inline
    // widgets that use `role="dialog"` for a11y (AskUserQuestion sticky,
    // CwdPopover) are explicitly NOT modal — they lack `data-modal-dialog`
    // and must not block the global Esc-to-stop shortcut.
    const fakeDialog = document.createElement('div');
    fakeDialog.setAttribute('role', 'dialog');
    fakeDialog.setAttribute('data-modal-dialog', '');
    document.body.appendChild(fakeDialog);
    try {
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(api.agentInterrupt).not.toHaveBeenCalled();
    } finally {
      fakeDialog.remove();
    }
  });

  it('Esc still interrupts when an inline role="dialog" widget is present (e.g. AskUserQuestion sticky)', () => {
    // Regression: before this fix, ANY [role="dialog"] in the DOM blocked
    // the global Esc-to-stop. AskUserQuestion sticky and CwdPopover both
    // legitimately use role="dialog" for a11y but are NOT modal — Esc must
    // still interrupt the running turn even when one is mounted.
    freshStoreWithSession('s-inline', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-inline");
    const fakeInlineDialog = document.createElement('div');
    fakeInlineDialog.setAttribute('role', 'dialog');
    // No data-modal-dialog marker — this is the inline-widget shape.
    document.body.appendChild(fakeInlineDialog);
    try {
      act(() => {
        fireEvent.keyDown(document, { key: 'Escape' });
      });
      expect(api.agentInterrupt).toHaveBeenCalledWith('s-inline');
    } finally {
      fakeInlineDialog.remove();
    }
  });

  it('Esc fires interrupt when textarea has focus (no picker, no modal)', () => {
    // Regression for the report "焦点在 textarea 时按 Esc 无法 interrupt".
    // Doc-level handler must still fire because the textarea's own onKeyDown
    // does not consume Esc when no picker / mention / modal is open.
    freshStoreWithSession('s-ta', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-ta");
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    ta.focus();
    expect(document.activeElement).toBe(ta);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-ta');
  });

  it('interrupt clears unanswered AskUserQuestion sticky for the session', () => {
    // Regression: before this fix, the sticky AskUserQuestion card would
    // persist after Esc / Stop because the question block stayed unanswered
    // in the store, even though the agent had been interrupted.
    const sessionId = 's-q-clear';
    freshStoreWithSession(sessionId, { running: true, started: true });
    useStore.setState({
      messagesBySession: {
        [sessionId]: [
          {
            kind: 'question',
            id: 'q-1',
            questions: [{ question: 'Pick one', options: [{ label: 'A' }] }]
          }
        ]
      }
    });
    const api = stubCCSM();
    renderWithProviders(sessionId);
    act(() => {
      fireEvent.keyDown(document, { key: 'Escape' });
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith(sessionId);
    const blocks = useStore.getState().messagesBySession[sessionId] ?? [];
    const q = blocks.find((b) => b.id === 'q-1');
    expect(q && q.kind === 'question' && q.answered).toBe(true);
    expect(q && q.kind === 'question' && q.rejected).toBe(true);
  });
});

describe('InputBar: send-while-running enqueues into FIFO', () => {
  it('typing + Send while running enqueues instead of calling agentSend', () => {
    freshStoreWithSession('s-q', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-q");
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    fireEvent.change(ta, { target: { value: 'queued thought' } });
    // Press Enter to submit (existing send keybind).
    fireEvent.keyDown(ta, { key: 'Enter' });
    expect(api.agentSend).not.toHaveBeenCalled();
    const q = useStore.getState().messageQueues['s-q'];
    expect(q).toHaveLength(1);
    expect(q[0].text).toBe('queued thought');
    // Composer cleared after enqueue so the user can type the next thought.
    expect((ta as HTMLTextAreaElement).value).toBe('');
  });

  it('renders a +N queued chip reflecting queue length', () => {
    freshStoreWithSession('s-chip', { running: true, started: true });
    stubCCSM();
    act(() => {
      useStore.getState().enqueueMessage('s-chip', { text: 'first', attachments: [] });
      useStore.getState().enqueueMessage('s-chip', { text: 'second', attachments: [] });
    });
    renderWithProviders("s-chip");
    expect(screen.getByText('+2 queued')).toBeInTheDocument();
  });

  it('Stop clears the queue (CLI Ctrl+C behavior)', async () => {
    freshStoreWithSession('s-stop', { running: true, started: true });
    const api = stubCCSM();
    renderWithProviders("s-stop");
    act(() => {
      useStore.getState().enqueueMessage('s-stop', { text: 'pending', attachments: [] });
    });
    expect(useStore.getState().messageQueues['s-stop']).toHaveLength(1);
    // Click the visible Stop button.
    const stopBtn = screen.getByRole('button', { name: /stop/i });
    await act(async () => {
      fireEvent.click(stopBtn);
    });
    expect(api.agentInterrupt).toHaveBeenCalledWith('s-stop');
    expect(useStore.getState().messageQueues['s-stop']).toBeUndefined();
  });
});

describe('InputBar: textarea remains editable while running', () => {
  it('does not set the disabled attribute on the textarea during a running turn', () => {
    freshStoreWithSession('s-edit', { running: true, started: true });
    stubCCSM();
    renderWithProviders("s-edit");
    const ta = screen.getByRole('textbox') as HTMLTextAreaElement;
    expect(ta.disabled).toBe(false);
    fireEvent.change(ta, { target: { value: 'still typing' } });
    expect(ta.value).toBe('still typing');
  });
});
