// TDD tests for the phone PWA bootstrap orchestration (mobile
// composer/terminal-sync plan, Task 5 review fix). Proves the
// subscribe-before-connect ordering invariant: `createMobileRemoteStore`
// (and therefore its `client.onMessage`/`onStatus` subscriptions) must be
// wired before `RelayClient.connect()` is ever called, so a transport that
// emits a status or message synchronously from `connect()` can never be
// missed — regardless of whether/when React actually flushes
// `<PhoneShell>`. Also proves store-ownership/disposal stays with
// bootstrap (never double-disposed, never duplicated into a second store
// created by `<PhoneShell>` itself).

import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bootstrap } from '../../src/mobile/bootstrap';
import { createMobileRemoteStore as realCreateMobileRemoteStore } from '../../src/mobile/mobileRemoteStore';
import type { PhoneConnectionStatus, RelayClient } from '../../src/mobile/relayClient';
import type { MobileServerMessage, PairingIdentity } from '../../src/shared/mobileRemote';
import type { MobileTerminalAdapterFactory } from '../../src/mobile/components/MobileTerminal';

const PAIRING: PairingIdentity = { roomId: 'B'.repeat(43), secret: 'A'.repeat(43) };

// Bootstrap renders the real `<PhoneShell>`, which by default builds a real
// xterm.js terminal — unnecessary DOM/canvas/matchMedia machinery for
// these wiring-order/ownership tests. A fake adapter factory (the same
// test seam `<PhoneShell>` already exposes) keeps them focused on
// bootstrap's own orchestration.
const fakeCreateAdapter: MobileTerminalAdapterFactory = () => ({
  apply: () => {},
  fit: () => {},
  copySelection: () => Promise.resolve(),
  serialize: () => '',
  dispose: () => {},
});

function fakePairingStore() {
  return { get: vi.fn(), put: vi.fn() };
}

// A minimal fake `RelayClient` that records the *order* in which the
// bootstrap wires it up (`onMessage`/`onStatus` subscription vs. `connect()`
// invocation), and can simulate a transport that delivers a status
// synchronously from `connect()` itself — the exact hazard
// subscribe-before-connect ordering guards against.
function createOrderTrackingClient(calls: string[]): RelayClient {
  const messageHandlers = new Set<(message: MobileServerMessage) => void>();
  const statusHandlers = new Set<(status: PhoneConnectionStatus) => void>();
  return {
    connect() {
      calls.push('connect');
      for (const handler of statusHandlers) handler('connecting');
    },
    retry() {},
    send: () => Promise.resolve(),
    close() {},
    onMessage(handler) {
      calls.push('onMessage');
      messageHandlers.add(handler);
      return () => messageHandlers.delete(handler);
    },
    onStatus(handler) {
      calls.push('onStatus');
      statusHandlers.add(handler);
      return () => statusHandlers.delete(handler);
    },
  };
}

function setAppRoot(): void {
  document.body.innerHTML = '<div id="app"></div>';
}

function setSearch(search: string): void {
  window.history.pushState(null, '', `${window.location.pathname}${search}${window.location.hash}`);
}

afterEach(() => {
  document.body.innerHTML = '';
  setSearch('');
  vi.restoreAllMocks();
});

describe('phone bootstrap', () => {
  it('registers the mobile store onMessage/onStatus subscriptions before calling RelayClient.connect()', async () => {
    setAppRoot();
    const calls: string[] = [];
    const client = createOrderTrackingClient(calls);

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createAdapter: fakeCreateAdapter,
      });
    });

    const connectIndex = calls.indexOf('connect');
    expect(connectIndex).toBeGreaterThan(-1);
    expect(calls.indexOf('onMessage')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('onStatus')).toBeGreaterThanOrEqual(0);
    expect(calls.indexOf('onMessage')).toBeLessThan(connectIndex);
    expect(calls.indexOf('onStatus')).toBeLessThan(connectIndex);
  });

  it('shows the missing-pairing markup and never creates a relay client when no pairing is recovered', async () => {
    setAppRoot();
    const createRelayClient = vi.fn();
    await bootstrap({
      createPairingStore: fakePairingStore,
      importPairingFromFragment: async () => null,
      createRelayClient,
    });
    expect(createRelayClient).not.toHaveBeenCalled();
    expect(document.querySelector('#app')?.innerHTML).toContain('Scan the pairing QR code');
  });

  it('creates the mobile store exactly once and passes that same instance into PhoneShell', async () => {
    setAppRoot();
    const calls: string[] = [];
    const client = createOrderTrackingClient(calls);
    const createMobileRemoteStore = vi.fn((relayClient: RelayClient) =>
      realCreateMobileRemoteStore(relayClient),
    );

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createMobileRemoteStore,
        createAdapter: fakeCreateAdapter,
      });
    });

    expect(createMobileRemoteStore).toHaveBeenCalledTimes(1);
    // Proves `<PhoneShell>` rendered with the bootstrap-created store
    // instance rather than creating a second one of its own: the top bar
    // reflects a status delivered synchronously from the fake client's
    // `connect()`, which only that exact store's `onStatus` handler
    // (registered before `connect()`) could have received.
    expect(document.querySelector('.phone-topbar__connection')?.textContent).toBe('Connecting…');
  });

  it('disposes the bootstrap-owned store exactly once on beforeunload', async () => {
    setAppRoot();
    const calls: string[] = [];
    const client = createOrderTrackingClient(calls);
    let disposeSpy: ReturnType<typeof vi.spyOn> | undefined;
    const createMobileRemoteStore = (relayClient: RelayClient) => {
      const store = realCreateMobileRemoteStore(relayClient);
      disposeSpy = vi.spyOn(store.getState(), 'dispose');
      return store;
    };

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createMobileRemoteStore,
        createAdapter: fakeCreateAdapter,
      });
    });

    window.dispatchEvent(new Event('beforeunload'));
    window.dispatchEvent(new Event('beforeunload'));
    expect(disposeSpy).toHaveBeenCalledTimes(1);
  });

  it('still closes the client on beforeunload alongside disposing the store', async () => {
    setAppRoot();
    const calls: string[] = [];
    const client = createOrderTrackingClient(calls);
    const closeSpy = vi.spyOn(client, 'close');

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createAdapter: fakeCreateAdapter,
      });
    });

    window.dispatchEvent(new Event('beforeunload'));
    expect(closeSpy).toHaveBeenCalledOnce();
  });

  // Task 6: end-to-end proof that the real bootstrap wiring (not just the
  // PhoneShell unit tests) surfaces/hides the test-only serialization
  // bridge exactly on the `?ccsmTest=1` query param.
  it('does not define window.__ccsmMobileTest after a normal bootstrap (no ccsmTest query param)', async () => {
    setAppRoot();
    setSearch('');
    const client = createOrderTrackingClient([]);

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createAdapter: fakeCreateAdapter,
      });
    });

    expect(window.__ccsmMobileTest).toBeUndefined();
  });

  it('defines window.__ccsmMobileTest after bootstrap when the page URL has ?ccsmTest=1', async () => {
    setAppRoot();
    setSearch('?ccsmTest=1');
    const client = createOrderTrackingClient([]);

    await act(async () => {
      await bootstrap({
        createPairingStore: fakePairingStore,
        importPairingFromFragment: async () => PAIRING,
        createRelayClient: () => client,
        createAdapter: fakeCreateAdapter,
      });
    });

    expect(window.__ccsmMobileTest).toBeDefined();
    expect(Object.keys(window.__ccsmMobileTest!).sort()).toEqual([
      'getDimensions',
      'getSyncState',
      'serializeTerminal',
    ]);
    expect(typeof window.__ccsmMobileTest!.serializeTerminal()).toBe('string');
  });
});
