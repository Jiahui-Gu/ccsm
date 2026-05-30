import { session } from 'electron';

// Pure decider for the `will-navigate` allowlist (#804 risk #7). Allows the
// env-driven dev server origin (`CCSM_DEV_PORT`, defaulting to 4100 when
// unset) and any `file:` navigation (production renderer load). The literal
// `localhost:4100` was previously allowed unconditionally in addition to the
// env-driven origin — drop the literal so a stale dev port + dev build is not
// a navigation-bypass surface. Exported for the `installContextMenu`-style
// unit test in `__tests__/createWindow.test.ts`.
export function isAllowedNavigation(
  url: string,
  envDevPort: string | undefined,
): boolean {
  try {
    const u = new URL(url);
    const devPort = envDevPort && envDevPort.length > 0 ? envDevPort : '4100';
    return u.origin === `http://localhost:${devPort}` || u.protocol === 'file:';
  } catch {
    return false;
  }
}

// Content-Security-Policy (DEBT.md #17). The renderer shipped no CSP, so
// Electron logged an "Insecure Content-Security-Policy" warning and any
// renderer XSS had a wide blast radius (sandbox:false on the BrowserWindow).
// We set the policy as a *response header* via `onHeadersReceived` — the
// authoritative Electron approach — rather than an `http-equiv` meta tag,
// which can't express every directive (e.g. frame-ancestors / sandbox) and
// is applied later in the document lifecycle.
//
// Two profiles, keyed on the same dev/prod signal the loader uses
// (`deps.isDev` → webpack-dev-server URL vs packaged file:// bundle):
//
//   PROD (file://):
//     - script-src 'self'      — the `webpack --mode production` bundle is
//       devtool:false (no `eval`), so we DON'T need 'unsafe-eval'.
//     - style-src 'self' 'unsafe-inline' — style-loader injects Tailwind +
//       component CSS as inline <style> tags at runtime; without
//       'unsafe-inline' every style is refused and the app renders unstyled.
//     - img/font-src 'self' data: — @fontsource fonts + small inlined images
//       arrive as data: URIs.
//     - connect-src 'self' [+ Sentry ingest origin] — Sentry only posts to a
//       remote DSN when SENTRY_DSN is set (no hardcoded DSN in this repo); we
//       derive the ingest origin from that env so error reporting isn't
//       blocked when an operator opts in. Absent a DSN, connect-src stays
//       'self'.
//     - object-src/frame-src 'none' — no plugins, no embedded frames (the
//       ttyd terminal pane is a <webview>, not an <iframe>, and is governed by
//       webview CSP separately; the app never embeds frame/iframe content).
//     - base-uri 'self', default-src 'self'.
//
//   DEV (http://localhost:<port>):
//     - script-src adds 'unsafe-eval' — webpack-dev-server's default devtool
//       (`eval-*`) wraps every module in eval(); without it HMR + the initial
//       bundle are refused and the renderer never mounts.
//     - connect-src adds the dev-server origin + its HMR websocket
//       (ws://localhost:<port>) so live-reload/HMR can poll + push updates.

/** Derive the Sentry ingest origin from a DSN, or null when no DSN / the DSN
 *  is unparseable. A Sentry DSN looks like
 *  `https://<key>@<host>/<projectId>`; events POST to that host's origin, so
 *  that's what `connect-src` must allow. Exported for unit test. */
export function sentryIngestOrigin(dsn: string | undefined): string | null {
  if (!dsn || dsn.trim().length === 0) return null;
  try {
    return new URL(dsn.trim()).origin;
  } catch {
    return null;
  }
}

/** Pure CSP-string builder — extracted so the dev/prod policies can be
 *  unit-tested (and pasted into the PR body) without booting Electron.
 *  `isDev` mirrors `CreateWindowDeps.isDev`; `devPort` is `CCSM_DEV_PORT`
 *  (defaults to 4100); `sentryDsn` is `process.env.SENTRY_DSN`. */
export function buildCsp(
  isDev: boolean,
  devPort: string | undefined,
  sentryDsn: string | undefined,
): string {
  const port = devPort && devPort.length > 0 ? devPort : '4100';
  const sentryOrigin = sentryIngestOrigin(sentryDsn);

  const scriptSrc = ["'self'"];
  const connectSrc = ["'self'"];
  if (isDev) {
    // webpack-dev-server bundles via eval(); HMR uses an http poll + ws push.
    scriptSrc.push("'unsafe-eval'");
    connectSrc.push(`http://localhost:${port}`, `ws://localhost:${port}`);
  }
  if (sentryOrigin) connectSrc.push(sentryOrigin);

  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc.join(' ')}`,
    // style-loader injects inline <style> tags (Tailwind + component CSS).
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self' data:`,
    `connect-src ${connectSrc.join(' ')}`,
    `object-src 'none'`,
    `base-uri 'self'`,
    `frame-src 'none'`,
  ];
  return directives.join('; ');
}

// Guard so the `onHeadersReceived` hook is registered at most once on the
// shared `session.defaultSession`. `createWindow` can run more than once
// (macOS dock-activate re-create), and stacking handlers would append the
// CSP header N times.
let cspInstalled = false;

/** Test-only — reset the once-guard so a fresh test can re-install. */
export function __resetCspForTests(): void {
  cspInstalled = false;
}

/** Register the CSP response-header injector on the default session. No-op if
 *  already installed or if `session.defaultSession` is unavailable (e.g. the
 *  unit-test electron mock doesn't expose `session`). `isDev` selects the
 *  dev vs prod policy. */
export function installCsp(isDev: boolean): void {
  if (cspInstalled) return;
  const defaultSession = session?.defaultSession;
  if (!defaultSession?.webRequest?.onHeadersReceived) return;
  cspInstalled = true;
  const csp = buildCsp(isDev, process.env.CCSM_DEV_PORT, process.env.SENTRY_DSN);
  defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [csp],
      },
    });
  });
}
