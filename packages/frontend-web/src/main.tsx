import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { resolveDaemonBase, resolveToken, resolveWsBase, resolveWsPath, TOKEN_STORAGE_KEY } from './hostConfig';
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
//
// Task #780 (S3-T5): the default daemon base flipped to the CF Pages
// tunnel, so `/token` now goes to `https://cc-sm.pages.dev/token` unless
// the user passes `?daemon=` to redirect at a local loopback daemon.
//
// Task #31 (R-13): the boot path emits `[ccsm spa] …` console.log markers
// so the smoke spec's beforeEach console-forwarder can fingerprint where
// the SPA broke (token fetch failed / token resolved / ws url computed)
// without opening the headed browser. console.log only — no new try/catch,
// no control-flow change.
async function bootstrap(): Promise<void> {
  const rootEl = document.getElementById('root');
  if (!rootEl) {
    throw new Error('Root element #root not found');
  }

  const daemonBase = resolveDaemonBase({
    search: window.location.search,
  });

  console.log('[ccsm spa] fetching /token from', daemonBase || window.location.origin);

  // R-13: instrument the fetch passed into resolveToken so we log the actual
  // /token request URL + response status without changing resolveToken's
  // pure signature. Other fetches (REST API after boot) are not wrapped.
  const tracingFetch: typeof window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    if (url.endsWith('/token') || url.includes('/token?')) {
      const t0 = Date.now();
      const res = await window.fetch(input, init);
      console.log('[ccsm spa] /token response status=', res.status, 'in', Date.now() - t0, 'ms');
      return res;
    }
    return window.fetch(input, init);
  };

  const token = await resolveToken({
    search: window.location.search,
    fetch: tracingFetch,
    daemonBase,
  });

  if (!token) {
    console.error('[ccsm spa] token resolved null — rendering daemon-offline fallback');
    rootEl.innerHTML =
      '<div style="font-family:system-ui;padding:24px;color:#888;">' +
      'Daemon offline or no token available. Start the daemon, then reload this page.' +
      '</div>';
    return;
  }

  console.log('[ccsm spa] token resolved tokenLen=', token.length);

  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);

  // R-13: log the ws url the SessionRuntime / WsClient is about to dial.
  // Computed identically to webHostConfig (resolveWsBase + resolveWsPath)
  // so a mismatch between this log and the actual ws upgrade in worker logs
  // pinpoints a hostConfig drift.
  const wsBase = resolveWsBase({ search: window.location.search });
  const wsPath = resolveWsPath({ search: window.location.search }) ?? '/ws';
  console.log('[ccsm spa] ws connecting', `${wsBase}${wsPath}`);

  createRoot(rootEl).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

void bootstrap();
