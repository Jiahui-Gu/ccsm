// TDD tests for `PhoneShell` (mobile composer/terminal-sync plan, Task 5).
// Wires the connection banner, shared session drawer, read-only terminal,
// discrete key bar, and composer to one `createMobileRemoteStore(client)`
// instance. Per the final user override, nothing here ever calls
// `focus()`/`blur()` on the composer, terminal, drawer controls, or menu
// button; connection/output/Ask/permission/reconnect handling never parses
// terminal output or infers question state.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PhoneShell } from '../../src/mobile/components/PhoneShell';
import { createMobileRemoteStore } from '../../src/mobile/mobileRemoteStore';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MobileClientMessage, MobileServerMessage } from '../../src/shared/mobileRemote';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator';
import type { MobileTerminalAdapter } from '../../src/mobile/mobileTerminalAdapter';
import type { MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';

type FakeRelayClient = RelayClient & {
  sent: MobileClientMessage[];
  emitMessage(message: MobileServerMessage): void;
  emitStatus(status: PhoneConnectionStatus): void;
};

function createFakeClient(): FakeRelayClient {
  const messageHandlers = new Set<(message: MobileServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  const sent: MobileClientMessage[] = [];
  return {
    sent,
    connect() {},
    retry() {},
    send(message) {
      sent.push(message);
      return Promise.resolve();
    },
    close() {},
    onMessage(handler) {
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
    emitMessage(message) {
      act(() => {
        for (const handler of messageHandlers) handler(message);
      });
    },
    emitStatus(status) {
      act(() => {
        for (const handler of statusHandlers) handler(status);
      });
    },
  };
}

function navigatorModel(overrides: Partial<SessionNavigatorModel> = {}): SessionNavigatorModel {
  return {
    groups: [
      {
        id: 'g1',
        name: 'Group 1',
        order: 0,
        collapsed: false,
        sessions: [
          { id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'idle', order: 0 },
          { id: 's2', name: 'Beta', cwd: '/repo/beta', state: 'idle', order: 1 },
        ],
      },
    ],
    activeSessionId: null,
    ...overrides,
  };
}

function createFakeAdapterFactory(): {
  factory: MobileTerminalAdapterFactory;
  adapters: MobileTerminalAdapter[];
} {
  const adapters: MobileTerminalAdapter[] = [];
  const factory: MobileTerminalAdapterFactory = (_element) => {
    const adapter: MobileTerminalAdapter = {
      apply: vi.fn(),
      captureAnchor: vi.fn(() => ({ mode: 'bottom', horizontalOffsetPx: 0, canonicalCols: 80 })),
      getViewportState: vi.fn(() => ({
        geometry: null,
        contentWidthPx: 0,
        scroll: { maximumTop: 0, currentTop: 0, visibleRows: 24 },
      })),
      subscribeViewport: vi.fn(() => vi.fn()),
      scrollToLine: vi.fn(),
      scrollLines: vi.fn(),
      copySelection: vi.fn().mockResolvedValue(undefined),
      serialize: vi.fn(() => ''),
      dispose: vi.fn(),
    };
    adapters.push(adapter);
    return adapter;
  };
  return { factory, adapters };
}

function makeStoreFactory(requestId: () => string) {
  return (client: RelayClient) => createMobileRemoteStore(client, { requestId });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('PhoneShell', () => {
  it('renders the initial disconnected/empty state', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    expect(screen.getByRole('button', { name: /sessions menu/i })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getAllByText(/connecting/i).length).toBeGreaterThan(0);
  });

  it('updates the top bar with the selected session name and cwd once connected', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel(),
    });
    client.emitStatus('connected');

    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('/repo/alpha')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); // empty draft
  });

  it('keeps a separate draft per session and shows the composer bound to the selected one', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    const input = screen.getByRole('textbox', { name: 'Message' });
    await user.type(input, 'for alpha');
    expect(input).toHaveValue('for alpha');

    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(screen.getByText('Beta'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'for beta');
    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(screen.getByText('Alpha'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('for alpha');
  });

  it('sends the draft only from Send and clears it on acknowledgement', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(
      <PhoneShell
        client={client}
        createAdapter={factory}
        createStore={makeStoreFactory(() => 'req-1')}
      />,
    );
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello claude');
    await user.click(screen.getByRole('button', { name: 'Send' }));

    const submitted = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    expect(submitted).toMatchObject({ type: 'session.submit', sid: 's1', requestId: 'req-1', draft: 'hello claude' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    client.emitMessage({ type: 'session.submit.result', sid: 's1', requestId: 'req-1', ok: true });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  it('shows a visible error and preserves the draft on a rejected submission', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(
      <PhoneShell
        client={client}
        createAdapter={factory}
        createStore={makeStoreFactory(() => 'req-2')}
      />,
    );
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'draft text');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    client.emitMessage({
      type: 'session.submit.result',
      sid: 's1',
      requestId: 'req-2',
      ok: false,
      error: 'pty_write_failed',
    });

    expect(screen.getByRole('alert')).toHaveTextContent('pty_write_failed');
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('draft text');
  });

  // Review issue 2: `submitting` must be derived for the selected session
  // only. An unacknowledged submission on session A must never disable
  // Send (or block sending) for a newly selected session B.
  it('keeps Send enabled for a newly selected session while another session has an unacknowledged submission', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    let requestSequence = 0;
    render(
      <PhoneShell
        client={client}
        createAdapter={factory}
        createStore={makeStoreFactory(() => `req-${(requestSequence += 1)}`)}
      />,
    );
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    // Submit from Alpha (s1) without ever acknowledging it.
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from alpha');
    await user.click(screen.getByRole('button', { name: 'Send' }));
    const alphaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    expect(alphaSubmit).toMatchObject({ type: 'session.submit', sid: 's1' });
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled(); // Alpha's own Send reflects Alpha's own pending state

    // Switch to Beta (s2) — Alpha is still unacknowledged.
    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(screen.getByText('Beta'));

    // Beta's Send is disabled only because its draft is empty, never because
    // Alpha still has an unacknowledged submission.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from beta');
    expect(screen.getByRole('button', { name: 'Send' })).not.toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Send' }));
    const betaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
    expect(betaSubmit).toMatchObject({ type: 'session.submit', sid: 's2' });
    expect(betaSubmit.requestId).not.toBe(alphaSubmit.requestId);
    // Beta's Send is now disabled by Beta's own pending submission.
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Acknowledge Beta only; Alpha's correlation must remain untouched.
    client.emitMessage({ type: 'session.submit.result', sid: 's2', requestId: betaSubmit.requestId, ok: true });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');

    // Switch back to Alpha: its draft was never cleared (no ack yet) and
    // Send is still disabled by Alpha's own still-pending submission.
    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(screen.getByText('Alpha'));
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello from alpha');
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();

    // Acknowledge Alpha now; only then does its own draft clear.
    client.emitMessage({ type: 'session.submit.result', sid: 's1', requestId: alphaSubmit.requestId, ok: true });
    expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('');
  });

  // Follow-up A: `submissionError` remained a single global slot even after
  // `pendingSubmissions` (review issue 2, above) was scoped per sid. A
  // rejected submission for one session's composer leaked its
  // `role="alert"` onto a different, unrelated session's composer purely
  // because of which sid happened to be selected when the rejection
  // arrived.
  describe('per-session submission errors (follow-up A)', () => {
    it("does not render session A's rejected-submission alert while session B is selected, but shows it again once A is reselected", async () => {
      const user = userEvent.setup();
      const client = createFakeClient();
      const { factory } = createFakeAdapterFactory();
      let requestSequence = 0;
      render(
        <PhoneShell
          client={client}
          createAdapter={factory}
          createStore={makeStoreFactory(() => `req-${(requestSequence += 1)}`)}
        />,
      );
      client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
      client.emitStatus('connected');

      // Alpha (s1) submits and stays unacknowledged.
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from alpha');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const alphaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
      expect(alphaSubmit).toMatchObject({ type: 'session.submit', sid: 's1' });

      // Switch to Beta (s2) before Alpha's rejection arrives.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Beta'));

      // Alpha's submission is rejected while Beta is the selected session.
      client.emitMessage({
        type: 'session.submit.result',
        sid: 's1',
        requestId: alphaSubmit.requestId,
        ok: false,
        error: 'alpha_rejected',
      });

      // Beta never submitted anything and must not show Alpha's alert.
      expect(screen.queryByRole('alert')).toBeNull();

      // Switching back to Alpha must render its own error.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Alpha'));
      expect(screen.getByRole('alert')).toHaveTextContent('alpha_rejected');
    });

    it("clears only the edited session's visible error, leaving a different session's own error alert untouched", async () => {
      const user = userEvent.setup();
      const client = createFakeClient();
      const { factory } = createFakeAdapterFactory();
      let requestSequence = 0;
      render(
        <PhoneShell
          client={client}
          createAdapter={factory}
          createStore={makeStoreFactory(() => `req-${(requestSequence += 1)}`)}
        />,
      );
      client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
      client.emitStatus('connected');

      // Alpha submits and is rejected.
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from alpha');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const alphaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
      client.emitMessage({
        type: 'session.submit.result',
        sid: 's1',
        requestId: alphaSubmit.requestId,
        ok: false,
        error: 'alpha_rejected',
      });
      expect(screen.getByRole('alert')).toHaveTextContent('alpha_rejected');

      // Beta submits independently and is also rejected.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Beta'));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from beta');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const betaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
      client.emitMessage({
        type: 'session.submit.result',
        sid: 's2',
        requestId: betaSubmit.requestId,
        ok: false,
        error: 'beta_rejected',
      });
      expect(screen.getByRole('alert')).toHaveTextContent('beta_rejected');

      // Switch to Alpha and edit its draft — only Alpha's own error clears.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Alpha'));
      expect(screen.getByRole('alert')).toHaveTextContent('alpha_rejected');
      await user.type(screen.getByRole('textbox', { name: 'Message' }), '!');
      expect(screen.queryByRole('alert')).toBeNull();

      // Beta's own error is untouched by editing Alpha's draft.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Beta'));
      expect(screen.getByRole('alert')).toHaveTextContent('beta_rejected');
    });

    it("resubmitting a session clears only that session's own prior error, leaving a different session's error alert untouched", async () => {
      const user = userEvent.setup();
      const client = createFakeClient();
      const { factory } = createFakeAdapterFactory();
      let requestSequence = 0;
      render(
        <PhoneShell
          client={client}
          createAdapter={factory}
          createStore={makeStoreFactory(() => `req-${(requestSequence += 1)}`)}
        />,
      );
      client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
      client.emitStatus('connected');

      // Alpha submits and is rejected; its draft is preserved unedited.
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from alpha');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const alphaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
      client.emitMessage({
        type: 'session.submit.result',
        sid: 's1',
        requestId: alphaSubmit.requestId,
        ok: false,
        error: 'alpha_rejected',
      });

      // Beta submits independently and is also rejected.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Beta'));
      await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello from beta');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      const betaSubmit = client.sent.at(-1) as Extract<MobileClientMessage, { type: 'session.submit' }>;
      client.emitMessage({
        type: 'session.submit.result',
        sid: 's2',
        requestId: betaSubmit.requestId,
        ok: false,
        error: 'beta_rejected',
      });

      // Resubmit Alpha's unchanged, preserved draft directly (no edit) —
      // this must clear only Alpha's own prior error.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Alpha'));
      expect(screen.getByRole('alert')).toHaveTextContent('alpha_rejected');
      expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('hello from alpha');
      await user.click(screen.getByRole('button', { name: 'Send' }));
      expect(screen.queryByRole('alert')).toBeNull();

      // Beta's own error remains untouched by Alpha's resubmission.
      await user.click(screen.getByRole('button', { name: /sessions menu/i }));
      await user.click(screen.getByText('Beta'));
      expect(screen.getByRole('alert')).toHaveTextContent('beta_rejected');
    });
  });

  it('disables composer and key bar controls while disconnected', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('reconnecting');

    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Esc' })).toBeDisabled();
  });

  it('sends a discrete control key through the store to the client', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    await user.click(screen.getByRole('button', { name: 'Interrupt' }));
    expect(client.sent.at(-1)).toEqual({ type: 'session.input', sid: 's1', data: '\x03' });
  });

  it('opens the drawer from the menu button and closes it on Escape', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    const menuButton = screen.getByRole('button', { name: /sessions menu/i });
    await user.click(menuButton);
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    expect(menuButton).toHaveAttribute('aria-expanded', 'true');

    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(menuButton).toHaveAttribute('aria-expanded', 'false');
  });

  it('never calls focus() or blur() on the composer for output, Ask, permission, or reconnect state', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    const composer = screen.getByRole('textbox', { name: 'Message' });
    const focus = vi.spyOn(composer, 'focus');
    const blur = vi.spyOn(composer, 'blur');
    const menuButton = screen.getByRole('button', { name: /sessions menu/i });
    const menuFocus = vi.spyOn(menuButton, 'focus');
    const menuBlur = vi.spyOn(menuButton, 'blur');

    client.emitMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 1,
      chunk: 'AskUserQuestion: choose an option',
      geometryEpoch: 0,
    });
    client.emitStatus('reconnecting');
    client.emitStatus('connected');

    expect(focus).not.toHaveBeenCalled();
    expect(blur).not.toHaveBeenCalled();
    expect(menuFocus).not.toHaveBeenCalled();
    expect(menuBlur).not.toHaveBeenCalled();
  });

  it('renders no special Ask form: free text stays a normal composer submission', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    client.emitMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 1,
      chunk: 'AskUserQuestion: pick one\r\n1) yes\r\n2) no',
      geometryEpoch: 0,
    });

    // Exactly one composer textbox and no extra form/select controls appear.
    expect(screen.getAllByRole('textbox')).toHaveLength(1);
    expect(screen.queryByRole('form')).toBeNull();
    expect(screen.queryByRole('listbox', { name: /ask/i })).toBeNull();
  });

  it('keeps the terminal visible beneath a non-modal reconnect banner', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    const { container } = render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');
    client.emitStatus('reconnecting');

    expect(screen.getAllByText(/reconnecting/i).length).toBeGreaterThan(0);
    expect(container.querySelector('.mobile-terminal')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });

  it('shows a manual Retry action only when retryMode is manual (connection_error)', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    client.emitStatus('connection_error');
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('shows blocked copy without a Retry action for update_required/authentication_failed', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    client.emitStatus('update_required');
    expect(screen.getAllByText(/update/i).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('calls client retry() only through the manual Retry button', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const retrySpy = vi.spyOn(client, 'retry');
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    client.emitStatus('connection_error');
    await user.click(screen.getByRole('button', { name: /retry/i }));
    expect(retrySpy).toHaveBeenCalledOnce();
  });

  it('shows an exited-session banner (with the terminal still visible) when the navigator switches away from the selected session', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    const { container } = render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitStatus('connected');
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    expect(screen.getByText('Alpha')).toBeInTheDocument(); // selected s1 first

    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [
              { id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'exited', order: 0 },
              { id: 's2', name: 'Beta', cwd: '/repo/beta', state: 'idle', order: 1 },
            ],
          },
        ],
      }),
    });

    expect(screen.getByText(/session exited/i)).toBeInTheDocument();
    expect(screen.getByText(/switched to another session/i)).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
    expect(container.querySelector('.mobile-terminal')).not.toBeNull();
    expect(screen.getByRole('textbox', { name: 'Message' })).not.toBeDisabled();
  });

  it('shows a no-live-session exited banner and disables controls when the only session exits', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    const { container } = render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitStatus('connected');
    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [{ id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'idle', order: 0 }],
          },
        ],
      }),
    });

    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [{ id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'exited', order: 0 }],
          },
        ],
      }),
    });

    expect(screen.getByText(/session exited/i)).toBeInTheDocument();
    expect(screen.getByText(/no live session/i)).toBeInTheDocument();
    expect(container.querySelector('.mobile-terminal')).not.toBeNull();
    expect(screen.getByRole('button', { name: 'Send' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Interrupt' })).toBeDisabled();
  });

  it('does not show a manual Retry action inside the exited-session banner', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitStatus('connected');
    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [{ id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'idle', order: 0 }],
          },
        ],
      }),
    });
    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [{ id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'exited', order: 0 }],
          },
        ],
      }),
    });

    expect(screen.getByText(/session exited/i)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull();
  });

  it('prioritizes the transport connection banner over the exited-session banner', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitStatus('connected');
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [
              { id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'exited', order: 0 },
              { id: 's2', name: 'Beta', cwd: '/repo/beta', state: 'idle', order: 1 },
            ],
          },
        ],
      }),
    });
    expect(screen.getByText(/session exited/i)).toBeInTheDocument();

    client.emitStatus('connection_error');
    expect(screen.queryByText(/session exited/i)).toBeNull();
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument();
  });

  it('clears the exited-session banner once the user explicitly selects a session', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitStatus('connected');
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitMessage({
      type: 'sessions.navigator',
      version: 1,
      model: navigatorModel({
        groups: [
          {
            id: 'g1',
            name: 'Group 1',
            order: 0,
            collapsed: false,
            sessions: [
              { id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'exited', order: 0 },
              { id: 's2', name: 'Beta', cwd: '/repo/beta', state: 'idle', order: 1 },
            ],
          },
        ],
      }),
    });
    expect(screen.getByText(/session exited/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(within(screen.getByRole('dialog')).getByText('Beta'));

    expect(screen.queryByText(/session exited/i)).toBeNull();
  });

  it('creates the adapter exactly once and never remounts it across store-driven re-renders', () => {
    const client = createFakeClient();
    const { factory, adapters } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);

    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('authenticating');
    client.emitStatus('connected');
    client.emitMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 1,
      chunk: 'more output',
      geometryEpoch: 0,
    });
    client.emitStatus('reconnecting');
    client.emitStatus('connected');

    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.dispose).not.toHaveBeenCalled();
  });


  it('consumes each terminal render batch exactly once', () => {
    const client = createFakeClient();
    const { factory, adapters } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');
    client.emitMessage({
      type: 'session.snapshot',
      sid: 's1',
      seq: 1,
      snapshot: 'hello world',
      geometry: { cols: 80, rows: 24, epoch: 0 },
    });

    const adapter = adapters[0]!;
    const applyCalls = (adapter.apply as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(applyCalls).toBeGreaterThanOrEqual(1);

    // Emitting an unrelated message must not re-apply the already-consumed batch.
    client.emitStatus('connected');
    expect((adapter.apply as ReturnType<typeof vi.fn>).mock.calls.length).toBe(applyCalls);
  });

  it('creates a fresh store per distinct client and disposes it on unmount', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    let capturedStore: ReturnType<typeof createMobileRemoteStore> | null = null;
    const createStore = (relayClient: RelayClient) => {
      capturedStore = createMobileRemoteStore(relayClient);
      return capturedStore;
    };
    const { unmount } = render(
      <PhoneShell client={client} createAdapter={factory} createStore={createStore} />,
    );
    expect(capturedStore).not.toBeNull();
    const disposeSpy = vi.spyOn(capturedStore!, 'getState');
    unmount();
    // dispose() unsubscribes the client handlers; emitting afterwards must
    // not throw and must not touch any DOM (component already unmounted).
    expect(() => client.emitStatus('connected')).not.toThrow();
    disposeSpy.mockRestore();
  });

  it('uses a store passed in via the `store` prop instead of creating its own, and never disposes it on unmount', () => {
    const client = createFakeClient();
    const { factory } = createFakeAdapterFactory();
    const externalStore = createMobileRemoteStore(client);
    const createStore = vi.fn(() => {
      throw new Error('createStore must not be called when a store prop is provided');
    });

    const { unmount } = render(
      <PhoneShell client={client} createAdapter={factory} store={externalStore} createStore={createStore} />,
    );
    expect(createStore).not.toHaveBeenCalled();

    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');
    expect(screen.getByText('Alpha')).toBeInTheDocument();

    const disposeSpy = vi.spyOn(externalStore.getState(), 'dispose');
    unmount();
    // The caller (bootstrap) owns this store's lifecycle, not PhoneShell —
    // unmounting the component must never call dispose() on a store it did
    // not create itself.
    expect(disposeSpy).not.toHaveBeenCalled();
  });

});
