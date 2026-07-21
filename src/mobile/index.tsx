// Phone PWA bootstrap (mobile composer/terminal-sync plan, Task 5). Wires
// pairing recovery, the encrypted relay client, service-worker
// registration, and the beforeunload close hook exactly as the previous
// vanilla-DOM bootstrap did, then mounts the React `<PhoneShell>` in place
// of the old `createPhonePage`.

/* global HTMLMetaElement, location */

import { createRoot } from 'react-dom/client';

import '@xterm/xterm/css/xterm.css';
import './mobile.css';

import { PhoneShell } from './components/PhoneShell';
import {
  createPairingStore,
  importPairingFromFragment,
  installPairingFragmentReload,
} from './pairing';
import { createRelayClient } from './relayClient';

// Static, developer-authored markup only — never interpolates any
// pairing/session/server-derived value — so this is not an untrusted-input
// innerHTML sink.
const MISSING_PAIRING_MARKUP =
  '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Scan the pairing QR code in CCSM to connect.</p></main>';

const START_FAILURE_MARKUP =
  '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Unable to start the phone remote.</p></main>';

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('missing_app_root');
  const pairing = await importPairingFromFragment(createPairingStore());
  if (!pairing) {
    root.innerHTML = MISSING_PAIRING_MARKUP;
    return;
  }

  const client = createRelayClient({ relayUrl: location.origin, pairing });
  window.addEventListener('beforeunload', () => client.close(), { once: true });
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

  createRoot(root).render(<PhoneShell client={client} />);
}

installPairingFragmentReload();
void bootstrap().catch(() => {
  const root = document.querySelector<HTMLElement>('#app');
  if (root) root.innerHTML = START_FAILURE_MARKUP;
});
