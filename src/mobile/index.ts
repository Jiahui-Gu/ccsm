/* global HTMLMetaElement, location */

import '@xterm/xterm/css/xterm.css';
import './mobile.css';

import { createPairingStore, importPairingFromFragment } from './pairing';
import { createPhonePage, renderMissingPairing } from './phonePage';
import { createRelayClient } from './relayClient';

async function bootstrap(): Promise<void> {
  const root = document.querySelector<HTMLElement>('#app');
  if (!root) throw new Error('missing_app_root');
  const pairing = await importPairingFromFragment(createPairingStore());
  if (!pairing) {
    renderMissingPairing(root);
    return;
  }

  const client = createRelayClient({ relayUrl: location.origin, pairing });
  createPhonePage(root, client);
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
}

void bootstrap().catch(() => {
  const root = document.querySelector<HTMLElement>('#app');
  if (root) {
    root.innerHTML =
      '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Unable to start the phone remote.</p></main>';
  }
});
