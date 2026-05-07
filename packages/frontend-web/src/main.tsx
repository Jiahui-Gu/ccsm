import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveToken, TOKEN_STORAGE_KEY } from './hostConfig';
import '@ccsm/ui/styles.css';

// Task #696: token bootstrap.
//   1. URL `?token=` (back-compat with legacy `ccsm ready: http://...?token=`)
//   2. fetch /token from the same-origin daemon (loopback-only, see daemon
//      http.mts — no auth, returns `{ token }`)
//   3. neither -> render a friendly "daemon offline" message and bail.
async function bootstrap(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  const token = await resolveToken({
    search: window.location.search,
    fetch: window.fetch.bind(window),
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
