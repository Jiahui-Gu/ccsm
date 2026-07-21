// Phone PWA production entry point (mobile composer/terminal-sync plan,
// Task 5). Thin by design: it only owns the pairing-fragment reload guard,
// bundled stylesheet imports, and the unconditional production auto-run of
// `bootstrap()`. All bootstrap orchestration — subscribe-before-connect
// store ordering, pairing recovery, service-worker registration, and the
// beforeunload close/dispose hook — lives in `./bootstrap`, which stays
// side-effect-free on import so it can be exercised directly in tests
// without this module's auto-run ever firing.

import '@xterm/xterm/css/xterm.css';
import './mobile.css';

import { installPairingFragmentReload } from './pairing';
import { bootstrap } from './bootstrap';

// Static, developer-authored markup only — never interpolates any
// pairing/session/server-derived value — so this is not an untrusted-input
// innerHTML sink.
const START_FAILURE_MARKUP =
  '<main class="missing-pairing"><h1>CCSM Mobile Remote</h1><p>Unable to start the phone remote.</p></main>';

installPairingFragmentReload();
void bootstrap().catch(() => {
  const root = document.querySelector<HTMLElement>('#app');
  if (root) root.innerHTML = START_FAILURE_MARKUP;
});

