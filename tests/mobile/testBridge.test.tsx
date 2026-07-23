// TDD tests for the mobile remote's test-only serialization bridge (mobile
// composer/terminal-sync plan, Task 6). `window.__ccsmMobileTest` must:
//   - be completely absent during a normal (non-test) page load;
//   - appear only when the page URL has `?ccsmTest=1`;
//   - expose exactly `serializeTerminal()` and `getSyncState()` — nothing
//     else (no pairing identity/secret, encryption keys, drafts, relay
//     frames, the `RelayClient`, or the raw zustand store);
//   - have `getSyncState()` return exactly the JSON-safe sync fields
//     (sid/phase/geometryEpoch/lastSeq/snapshotRequested/recoveryReason/
//     bufferedSeqs) — no `drafts` or
//     any other store field;
//   - reference the same long-lived adapter/store for the whole component
//     lifetime (no remounting), and clean itself up on unmount.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { PhoneShell } from '../../src/mobile/components/PhoneShell';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MobileClientMessage, MobileServerMessage } from '../../src/shared/mobileRemote';
import type { SessionNavigatorModel } from '../../src/shared/sessionNavigator';
import type { MobileTerminalAdapter } from '../../src/mobile/mobileTerminalAdapter';
import type { MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';

type FakeRelayClient = RelayClient & {
  emitMessage(message: MobileServerMessage): void;
  emitStatus(status: PhoneConnectionStatus): void;
};

function createFakeClient(): FakeRelayClient {
  const messageHandlers = new Set<(message: MobileServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  return {
    connect() {},
    retry() {},
    send(_message: MobileClientMessage) {
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

function navigatorModel(): SessionNavigatorModel {
  return {
    groups: [
      {
        id: 'g1',
        name: 'Group 1',
        order: 0,
        collapsed: false,
        sessions: [{ id: 's1', name: 'Alpha', cwd: '/repo/alpha', state: 'idle', order: 0 }],
      },
    ],
    activeSessionId: null,
  };
}

function createFakeAdapterFactory(serializeReturn = 'serialized-buffer'): MobileTerminalAdapterFactory {
  return (_element, _options) => {
    const adapter: MobileTerminalAdapter = {
      apply: vi.fn(),
      fit: vi.fn(),
      copySelection: vi.fn().mockResolvedValue(undefined),
      serialize: vi.fn(() => serializeReturn),
      dispose: vi.fn(),
    };
    return adapter;
  };
}

function setSearch(search: string): void {
  window.history.pushState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
}

afterEach(() => {
  setSearch('');
  vi.restoreAllMocks();
});

describe('mobile test bridge (window.__ccsmMobileTest)', () => {
  it('is absent when the page has no ccsmTest query param (normal production load)', () => {
    setSearch('');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    expect(window.__ccsmMobileTest).toBeUndefined();
  });

  it('is absent for any other/unrelated query param', () => {
    setSearch('?other=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    expect(window.__ccsmMobileTest).toBeUndefined();
  });

  it('is absent when ccsmTest is present but not exactly "1"', () => {
    setSearch('?ccsmTest=true');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    expect(window.__ccsmMobileTest).toBeUndefined();
  });

  it('appears with exactly serializeTerminal + getSyncState when ?ccsmTest=1', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    const bridge = window.__ccsmMobileTest;
    expect(bridge).toBeDefined();
    expect(Object.keys(bridge!).sort()).toEqual(['getSyncState', 'serializeTerminal']);
  });

  it('serializeTerminal() delegates to the long-lived terminal adapter', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory('exact-adapter-output')} />);

    expect(window.__ccsmMobileTest!.serializeTerminal()).toBe('exact-adapter-output');
  });

  it('getSyncState() returns only JSON-safe synchronization fields', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    const state = window.__ccsmMobileTest!.getSyncState();
    expect(Object.keys(state).sort()).toEqual([
      'bufferedSeqs',
      'geometryEpoch',
      'lastSeq',
      'phase',
      'recoveryReason',
      'sid',
      'snapshotRequested',
    ]);
    expect(state).not.toHaveProperty('drafts');
    expect(state).not.toHaveProperty('pendingSubmission');
    expect(state).not.toHaveProperty('buffered'); // raw Map, not the JSON-safe bufferedSeqs array
  });

  it('getSyncState() reflects the real store: sid updates on selection, bufferedSeqs on a gap', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    expect(window.__ccsmMobileTest!.getSyncState()).toMatchObject({ sid: null, phase: 'idle' });

    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    expect(window.__ccsmMobileTest!.getSyncState()).toMatchObject({ sid: 's1', phase: 'syncing' });

    // Gap: seq 5 arrives while nothing has been applied yet (lastSeq -1) —
    // not the immediate next seq, so it gets buffered rather than written.
    client.emitMessage({
      type: 'pty.data',
      sid: 's1',
      seq: 5,
      chunk: 'tail',
      geometryEpoch: 0,
    });
    const gapped = window.__ccsmMobileTest!.getSyncState();
    expect(gapped.bufferedSeqs).toEqual([5]);
    expect(gapped.geometryEpoch).toBeNull();
    expect(gapped.snapshotRequested).toBe(true);
    expect(gapped.recoveryReason).toBe('initial');
  });

  it('does not expose pairing identity/secret, encryption keys, the client, or the raw store anywhere on the bridge', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);

    const bridge = window.__ccsmMobileTest as unknown as Record<string, unknown>;
    for (const forbidden of [
      'pairing',
      'secret',
      'roomId',
      'client',
      'store',
      'drafts',
      'keys',
      'frames',
      'buffered',
    ]) {
      expect(bridge).not.toHaveProperty(forbidden);
    }
  });

  it('cleans up window.__ccsmMobileTest on unmount', () => {
    setSearch('?ccsmTest=1');
    const client = createFakeClient();
    const { unmount } = render(<PhoneShell client={client} createAdapter={createFakeAdapterFactory()} />);
    expect(window.__ccsmMobileTest).toBeDefined();

    unmount();

    expect(window.__ccsmMobileTest).toBeUndefined();
  });

  it('keeps referencing the same long-lived adapter/store across unrelated re-renders (no remount, no focus/blur)', async () => {
    setSearch('?ccsmTest=1');
    const user = userEvent.setup();
    const client = createFakeClient();
    const adapterFactory = createFakeAdapterFactory('stable-output');
    const factorySpy = vi.fn(adapterFactory);
    render(<PhoneShell client={client} createAdapter={factorySpy} />);

    client.emitMessage({ type: 'sessions.navigator', version: 1, model: navigatorModel() });
    client.emitStatus('connected');

    // Real typing legitimately involves the browser's own native focus of
    // the field the user types into — that is not app-driven focus
    // management. Let that happen first, then spy afterward so only
    // *app-driven* focus/blur triggered by unrelated store churn (status
    // flips) below can trip the assertion.
    await user.type(screen.getByRole('textbox', { name: 'Message' }), 'hello');

    const focusSpy = vi.spyOn(HTMLElement.prototype, 'focus');
    const blurSpy = vi.spyOn(HTMLElement.prototype, 'blur');

    // Unrelated store churn (reconnect/reconnected) must not recreate the
    // adapter or move focus — the bridge must keep working off the same
    // long-lived instance.
    client.emitStatus('reconnecting');
    client.emitStatus('connected');

    expect(window.__ccsmMobileTest!.serializeTerminal()).toBe('stable-output');
    expect(factorySpy).toHaveBeenCalledOnce();
    expect(focusSpy).not.toHaveBeenCalled();
    expect(blurSpy).not.toHaveBeenCalled();
  });
});
