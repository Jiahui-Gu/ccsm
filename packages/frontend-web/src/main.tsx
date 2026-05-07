import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveDaemonBase, resolveToken, TOKEN_STORAGE_KEY } from './hostConfig';
import '@ccsm/ui/styles.css';

// Task #696: token bootstrap.
//   1. URL `?token=` (back-compat with legacy `ccsm ready: http://...?token=`)
//   2. fetch <daemonBase>/token — same-origin in the daemon-embedded case,
//      cross-origin (with CORS, see daemon http.mts) when SPA is on Pages.
//   3. neither -> render a friendly "daemon offline" message and bail.
//
// Task #719 (S2-T4): the /token request must use the resolved daemon base
// so it works in cross-origin mode (Pages → loopback daemon). Same-origin
// loopback continues to hit `<origin>/token` because resolveDaemonBase
// returns window.location.origin in that case.
async function bootstrap(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  const daemonBase = resolveDaemonBase({
    search: window.location.search,
    hostname: window.location.hostname,
    origin: window.location.origin,
    envBase: import.meta.env.VITE_DAEMON_BASE,
  });

  const token = await resolveToken({
    search: window.location.search,
    fetch: window.fetch.bind(window),
    daemonBase,
  });

  if (!token) {
    rootEl.innerHTML =
      '<div style="font-family:system-ui;padding:24px;color:#888;">' +
      'Daemon offline or no token available. Start the daemon, then reload this page.' +
      '</div>';
    return;
  }

  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
