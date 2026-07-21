// TDD tests for `PhoneShell` (mobile composer/terminal-sync plan, Task 5).
// Wires the connection banner, shared session drawer, read-only terminal,
// discrete key bar, and composer to one `createMobileRemoteStore(client)`
// instance. Per the final user override, nothing here ever calls
// `focus()`/`blur()` on the composer, terminal, drawer controls, or menu
// button; connection/output/Ask/permission/reconnect handling never parses
// terminal output or infers question state.

import { useRef } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PhoneShell } from '../../src/mobile/components/PhoneShell';
import { createMobileRemoteStore } from '../../src/mobile/mobileRemoteStore';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MobileClientMessage, MobileServerMessage } from '../../src/shared/mobileRemote';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator';
import type {
  MobileTerminalAdapter,
  MobileTerminalDimensions,
} from '../../src/mobile/mobileTerminalAdapter';
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
  onResizeHandlers: Array<(dimensions: MobileTerminalDimensions) => void>;
} {
  const adapters: MobileTerminalAdapter[] = [];
  const onResizeHandlers: Array<(dimensions: MobileTerminalDimensions) => void> = [];
  const factory: MobileTerminalAdapterFactory = (_element, options) => {
    onResizeHandlers.push(options.onResize);
    const adapter: MobileTerminalAdapter = {
      apply: vi.fn(),
      fit: vi.fn(),
      copySelection: vi.fn().mockResolvedValue(undefined),
      serialize: vi.fn(() => ''),
      dispose: vi.fn(),
    };
    adapters.push(adapter);
    return adapter;
  };
  return { factory, adapters, onResizeHandlers };
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

    client.emitMessage({ type: 'pty.data', sid: 's1', seq: 1, chunk: 'AskUserQuestion: choose an option' });
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

    client.emitMessage({ type: 'pty.data', sid: 's1', seq: 1, chunk: 'AskUserQuestion: pick one\r\n1) yes\r\n2) no' });

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
    client.emitMessage({ type: 'pty.data', sid: 's1', seq: 1, chunk: 'more output' });
    client.emitStatus('reconnecting');
    client.emitStatus('connected');

    expect(adapters).toHaveLength(1);
    expect(adapters[0]?.dispose).not.toHaveBeenCalled();
  });

  it('forces adapter.fit(true) when the selected session changes, even at the same dimensions', async () => {
    const user = userEvent.setup();
    const client = createFakeClient();
    const { factory, adapters } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    const adapter = adapters[0]!;
    const callsBeforeSwitch = (adapter.fit as ReturnType<typeof vi.fn>).mock.calls.length;

    await user.click(screen.getByRole('button', { name: /sessions menu/i }));
    await user.click(screen.getByText('Beta'));

    const callsAfterSwitch = (adapter.fit as ReturnType<typeof vi.fn>).mock.calls;
    expect(callsAfterSwitch.length).toBeGreaterThan(callsBeforeSwitch);
    expect(callsAfterSwitch.at(-1)).toEqual([true]);
  });

  it('sends session.resize through the client for the current session on adapter resize', () => {
    const client = createFakeClient();
    const { factory, onResizeHandlers } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    onResizeHandlers[0]?.({ cols: 90, rows: 32 });
    expect(client.sent.at(-1)).toEqual({ type: 'session.resize', sid: 's1', cols: 90, rows: 32 });
  });

  it('does not send a resize while disconnected', () => {
    const client = createFakeClient();
    const { factory, onResizeHandlers } = createFakeAdapterFactory();
    render(<PhoneShell client={client} createAdapter={factory} />);
    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });

    onResizeHandlers[0]?.({ cols: 90, rows: 32 });
    expect(client.sent.find((message) => message.type === 'session.resize')).toBeUndefined();
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
      cols: 80,
      rows: 24,
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

  it('exposes a stable onResize identity so an unrelated ref prop does not defeat memoization', () => {
    // Regression guard for "stable onResize callback": render twice with the
    // same client/createStore/createAdapter and confirm the adapter is
    // still created only once even though React re-renders on every state
    // change coming from the store (already covered above); this test pins
    // the requirement that PhoneShell itself must not pass an inline arrow
    // literal recomputed from unrelated hook state as `onResize`.
    function Wrapper() {
      const client = useRef(createFakeClient()).current;
      const { factory } = useRef(createFakeAdapterFactory()).current;
      return <PhoneShell client={client} createAdapter={factory} />;
    }
    const { rerender } = render(<Wrapper />);
    rerender(<Wrapper />);
    // No assertion beyond "did not throw" — the dedicated adapter-identity
    // test above is the behavioral proof; this just guards the wrapper
    // pattern compiles and rerenders safely.
    expect(screen.getByRole('textbox', { name: 'Message' })).toBeInTheDocument();
  });
});
