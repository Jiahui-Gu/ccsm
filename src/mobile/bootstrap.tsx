// Phone PWA bootstrap orchestration (mobile composer/terminal-sync plan,
// Task 5). Wires pairing recovery, the encrypted relay client, the mobile
// remote store, service-worker registration, and the beforeunload
// close/dispose hook exactly as the previous vanilla-DOM bootstrap did, then
// mounts the React `<PhoneShell>` in place of the old `createPhonePage`.
//
// Split out from `index.tsx` (the auto-running production entry) precisely
// so this orchestration — and, most importantly, its subscribe-before-
// connect ordering — can be exercised directly in tests without triggering
// any top-level side effect on import: `index.tsx` still calls `bootstrap()`
// unconditionally at module load for production, but importing this module
// alone never does.

/* global HTMLMetaElement, location */

import { createRoot } from 'react-dom/client';
import type { StoreApi } from 'zustand/vanilla';

import { PhoneShell } from './components/PhoneShell';
import type { MobileTerminalAdapterFactory } from './components/MobileTerminal';
import { createPairingStore, importPairingFromFragment, type PairingStore } from './pairing';
import { createRelayClient, type RelayClient, type RelayClientOptions } from './relayClient';
import { createMobileRemoteStore, type MobileRemoteStore } from './mobileRemoteStore';
import type { PairingIdentity } from '../shared/mobileRemote';

// Static, developer-authored markup only — never interpolates any
// pairing/session/server-derived value — so this is not an untrusted-input
// innerHTML sink.
const MISSING_PAIRING_MARKUP =
  '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Scan the pairing QR code in CCSM to connect.</p></main>';

// Every dependency `bootstrap()` touches that would otherwise reach a real
// browser API (IndexedDB, WebSocket, react-dom's client renderer) is
// injectable here, defaulting to the real production implementation, so
// `<PhoneShell>` still gets exactly the real production wiring when no
// overrides are supplied, and tests can substitute fakes without any
// top-level mocking. `createAdapter` has no meaningful non-real default
// (production always wants the real xterm-backed adapter) and stays
// `undefined` unless a test overrides it — mirroring `<PhoneShell>`'s own
// optional `createAdapter` test seam, only needed to keep bootstrap tests
// from constructing a real terminal (and its canvas/matchMedia
// dependencies) just to prove wiring order.
export type BootstrapDeps = {
  createPairingStore(): PairingStore;
  importPairingFromFragment(store: PairingStore): Promise<PairingIdentity | null>;
  createRelayClient(options: RelayClientOptions): RelayClient;
  createMobileRemoteStore(client: RelayClient): StoreApi<MobileRemoteStore>;
  createRoot: typeof createRoot;
  createAdapter?: MobileTerminalAdapterFactory;
};

const defaultDeps: BootstrapDeps = {
  createPairingStore,
  importPairingFromFragment,
  createRelayClient,
  createMobileRemoteStore,
  createRoot,
  createAdapter: undefined,
};

export async function bootstrap(overrides: Partial<BootstrapDeps> = {}): Promise<void> {
  const deps: BootstrapDeps = { ...defaultDeps, ...overrides };
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('missing_app_root');
  const pairing = await deps.importPairingFromFragment(deps.createPairingStore());
  if (!pairing) {
    root.innerHTML = MISSING_PAIRING_MARKUP;
    return;
  }

  const client = deps.createRelayClient({ relayUrl: location.origin, pairing });

  // Create the mobile store — and therefore register its `onMessage`/
  // `onStatus` subscriptions on `client` — before `client.connect()` is
  // ever called, never after. `RelayClient.connect()` is free to deliver a
  // status (or, via a future/fake transport, a message) synchronously; a
  // store created only once React gets around to rendering `<PhoneShell>`
  // could miss anything emitted between `connect()` and that render, which
  // may itself be deferred. Passing this same instance into `<PhoneShell>`
  // via its `store` prop (rather than letting the component create its own)
  // is what keeps this ordering guarantee true end-to-end.
  const store = deps.createMobileRemoteStore(client);

  // This store is owned by bootstrap, not by `<PhoneShell>` (which never
  // disposes a store it was handed via the `store` prop) — so bootstrap is
  // responsible for disposing it exactly once. Guarded so a repeated
  // `beforeunload` (browsers can fire it more than once in some flows) can
  // never double-dispose, independent of whether the store's own `dispose()`
  // happens to already be idempotent.
  let storeDisposed = false;
  function disposeStoreOnce(): void {
    if (storeDisposed) return;
    storeDisposed = true;
    store.getState().dispose();
  }

  window.addEventListener(
    'beforeunload',
    () => {
      disposeStoreOnce();
      client.close();
    },
    { once: true },
  );
  client.connect();

  if (window.isSecureContext && 'serviceWorker' in navigator) {
    const workerPath = document
      .querySelector<HTMLMetaElement>('meta[name="ccsm-service-worker"]')
      ?.content.trim();
    if (workerPath) {
      window.addEventListener(
        'load',
        () => {
          void navigator.serviceWorker.register(workerPath);
        },
        { once: true },
      );
    }
  }

  deps.createRoot(root).render(
    <PhoneShell client={client} store={store} createAdapter={deps.createAdapter} />,
  );
}
