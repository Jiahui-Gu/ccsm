# 04 — Web client (Vite SPA + Cloudflare Pages)

## Context block

The web client is the user-visible payoff of v0.4. Goal: open `https://app.<author-domain>` from any browser, hit Cloudflare Access, sign in via GitHub, and reach the user's daemon over Cloudflare Tunnel. The SPA reuses the same `src/` React renderer code as Electron — same components, same Zustand stores, same xterm.js terminal — packaged through Vite into static assets and deployed to Cloudflare Pages on push to `main`.

## TOC

- 1. Workspace layout (`web/` package)
- 2. Shared renderer packaging
- 3. Vite configuration
- 4. Build pipeline + Cloudflare Pages deploy
- 5. Local development
- 5.1. Transport-target injection (dev / test)
- 6. Offline / unreachable UX
- 6.5. Error reporting
- 7. Browser compatibility target
- 8. What's intentionally absent (no PWA, no service worker, no responsive redesign)
- 8.1. Web client storage / CSP / third-party policy

## 1. Workspace layout

```
ccsm/                              # repo root
├── package.json                   # workspace root
├── proto/                         # chapter 02
├── gen/ts/                        # generated proto bindings
├── daemon/                        # v0.3 daemon
├── electron/                      # Electron main + preload
├── src/                           # SHARED renderer (React, Zustand, xterm.js)
├── web/                           # NEW — Vite SPA wrapper
│   ├── package.json
│   ├── vite.config.ts
│   ├── index.html
│   ├── src/
│   │   ├── main.tsx               # SPA entry — mounts <App> from `src/App.tsx`
│   │   ├── transport.ts           # Connect-Web transport, talks to daemon over Tunnel
│   │   ├── bridges/               # web flavor of `electron/preload/bridges/*`
│   │   │   ├── ccsmCore.ts        # imports same surface, swaps impl
│   │   │   ├── ccsmSession.ts
│   │   │   ├── ccsmPty.ts
│   │   │   ├── ccsmNotify.ts
│   │   │   └── ccsmSessionTitles.ts
│   │   ├── platform/              # web-specific replacements
│   │   │   ├── clipboard.ts       # navigator.clipboard wrapper
│   │   │   ├── window-chrome.ts   # no-op window:* methods
│   │   │   └── folder-picker.ts   # File-API directory picker (or no-op)
│   │   └── auth/
│   │       └── access-redirect.ts # detects 401 from CF Access, redirects browser
│   └── public/
│       └── favicon.ico
└── ...
```

**Why a separate `web/` package vs. building from `electron/`:** Electron's preload script uses Node APIs (`contextBridge`, `electron.ipcRenderer`) that don't exist in browsers. Trying to share the preload would force conditional imports everywhere. A separate Vite entry point with its own preload-equivalent is cleaner.

**Why `src/` is shared, not duplicated:** the renderer is the product. Forking it doubles maintenance and guarantees drift. The shared package is enforced by `web/tsconfig.json` `paths` mapping `@/*` → `../src/*` (same as Electron's tsconfig).

## 2. Shared renderer packaging

The shared renderer (`src/`) imports browser-safe APIs only. This is already largely true (renderer runs in Chromium-renderer process under Electron), with three exceptions that v0.4 fixes:

1. **`process.platform` reads** — used in `src/` for "Cmd vs Ctrl" detection. Replace with a build-time `import.meta.env.VITE_PLATFORM` or runtime `navigator.platform` parse helper at `src/platform/getPlatform.ts`. Both Electron and web set `VITE_PLATFORM` at build time.
2. **`window.ccsm.window.platform`** — exposed by `ccsmCore.ts` bridge. Web bridge returns `'web'` literal; renderer's keyboard-shortcut helper handles the new value as "fallback to platform-detection from `navigator.platform`".
3. **Direct `electron.clipboard` reads** (rare, audit during M3) — none currently in `src/`; clipboard goes through `window.ccsmPty.clipboard.*` which is bridge-forked per chapter 03 §2.

**Bridge installation in web:** `web/src/main.tsx` calls `installCcsmCoreBridge()`, etc. — same names as Electron preload, but the implementations live in `web/src/bridges/`. They expose `window.ccsm*` so `src/` code is identical across both clients.

**Why mirror `installCcsm*Bridge` in web:** the renderer assumes `window.ccsm.foo` is available at module-evaluation time. Mirroring the install pattern means renderer init code (`src/index.tsx`) is unchanged.

**Bundle size:** Vite + Rollup tree-shake the unused bits. The original v0.4-pre estimate of "~600 KB gzipped" undercounted runtimes; realistic v0.4.0 first-load is **~800-1100 KB gzipped** when honestly accounting for:

- React + ReactDOM (~50 KB gz)
- xterm.js + addons `-fit`, `-web-links` (~250 KB gz; `-search` is dropped to keep within budget)
- `@connectrpc/connect` + `@connectrpc/connect-web` (~50 KB gz)
- `@bufbuild/protobuf` runtime (~30 KB gz)
- `gen/ts/` generated stubs for 46 RPCs (~70 KB gz)
- App code: Zustand, i18n bundles, framer-motion, Radix primitives, the renderer itself (~400-500 KB gz; v0.3 renderer is unmeasured today)

**M1 measurement spike (locked):** before chapter 09 M1 closes, run a one-day spike that bundles the current `src/` against the proto stubs and **measures**. Replace the §2 numbers above with `actual + 20% headroom` and lock that as the chapter 10 R10 CI gate threshold (rather than the speculative 800 KB). Cloudflare Pages serves with Brotli; effective wire size is ~70-75% of gzipped. First-load target: <2s on a 5 Mbps connection — **must be re-validated post-spike**.

**Code-splitting policy:** the manual chunks in §3 split for **caching**, not lazy load. Session-list is the landing route and MUST NOT eagerly pull the terminal chunk; `xterm` and friends lazy-load on first navigation to a session. M3 deliverable confirms.

**Renderer parity (Electron ↔ web):** "the renderer is the product" (above) is asserted as a goal, but drift creeps in via Electron-only conditionals, files imported by Electron but tree-shaken out of web, or divergent `tsconfig` `paths`. Chapter 08 adds a build-time **renderer-parity check** that diffs the imported file set from the Electron entry vs. the web entry; CI fails if any `src/**` file is reachable from one and not the other (allow-listed exceptions only). Slow drift won't survive M3 dogfood; CI catches it on the PR that introduces it.

## 3. Vite configuration

```ts
// web/vite.config.ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '../src'),
    },
  },
  define: {
    'import.meta.env.VITE_TARGET': JSON.stringify('web'),
    'import.meta.env.VITE_PLATFORM': JSON.stringify('web'),
  },
  server: {
    port: 5174,
    proxy: {
      // dev-time: forward /ccsm.v1.* to local daemon over HTTP/2
      // (custom middleware; see §5)
    },
  },
  build: {
    target: 'es2022',  // see §7
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          xterm: ['xterm', 'xterm-addon-fit', 'xterm-addon-web-links'],
          react: ['react', 'react-dom'],
          connect: ['@connectrpc/connect', '@connectrpc/connect-web'],
        },
      },
    },
  },
});
```

**Why `target: 'es2022'`:** Cloudflare Access blocks browsers older than ~2 years (see §7). ES2022 native (no transpile to ES2015) shrinks bundle ~15%.

**Why manual chunks for xterm/react/connect:** these change rarely; splitting them into their own chunks lets the browser cache them across renderer-app updates.

## 4. Build pipeline + Cloudflare Pages deploy

**Build command:** `npm run build:web` runs:
1. `buf generate` (regenerate proto bindings if stale)
2. `tsc -b web` (type-check)
3. `vite build` in `web/`

Output: `web/dist/` — static HTML/JS/CSS.

**Deploy:** Cloudflare Pages, GitHub integration. Pushes to `main` trigger a Pages build:
```yaml
# Configured via Cloudflare dashboard:
build_command: npm run build:web
build_output_directory: web/dist
root_directory: /
```

PR previews: every PR gets a unique preview URL `https://<sha>.ccsm-app.pages.dev`. Useful for review without needing Tunnel.

**Why GitHub-integration over `wrangler` from Actions:** less moving parts. Cloudflare has the GitHub OAuth already, builds in their environment, and serves the result. No CI secrets juggling.

**Routing:** SPA fallback. `web/dist/_redirects` contains `/* /index.html 200` so client-side routes (`/sessions/:id`) resolve to the SPA shell.

## 5. Local development

Local dev needs three things running:
1. Daemon (locally — `npm run daemon:dev`, watches + restarts on changes)
2. Vite dev server for the web SPA (`npm run web:dev` → `http://localhost:5174`)
3. (Optional) `cloudflared tunnel --url http://localhost:5174` to test the full Tunnel + Access path

**Without Tunnel** (the common case during dev): the dev Vite server uses a custom middleware to proxy `/ccsm.v1.*` paths to the local daemon's HTTP/2 listener (data socket — but in dev mode, daemon also binds an explicit TCP listener `127.0.0.1:7878` for browser access; Unix-socket dev is impractical from a browser). Vite middleware translates incoming HTTP/1.1 (browser default to localhost) requests into HTTP/2 to the daemon.

**Dev TCP listener — security model (BLOCKER fixes folded from R2/R3/R4/R5):** controlled by `CCSM_DAEMON_DEV_TCP=7878` env var **AND** a build-time symbol. The following are **MUST** requirements, not "MAY":

1. **Build-time gate (not runtime):** the production daemon binary MUST NOT contain the dev-listener code path. Implemented via an esbuild/rollup `define` constant `__CCSM_DEV_TCP_ENABLED__` set to `false` for prod builds and `true` for dev. The dev-listener module is wrapped in `if (__CCSM_DEV_TCP_ENABLED__) { ... }` so Rollup tree-shakes it out of the prod bundle entirely. Runtime-only `process.env.NODE_ENV` checks are insufficient — the symbol stays in the binary and one mistakenly-set env var re-enables it.
2. **Per-launch shared secret:** even in dev, the listener MUST require a per-launch random secret (printed to dev console at daemon start, sent by the SPA as an `X-CCSM-Dev-Secret` header). Raw `127.0.0.1` binding with no auth is unacceptable due to DNS rebinding (any browser tab on the dev box can reach `127.0.0.1:7878`).
3. **Strict `Host` header validation:** the dev listener MUST reject any request whose `Host` header is not exactly `localhost:7878` or `127.0.0.1:7878` (HTTP 421 Misdirected Request). This defeats DNS rebinding from arbitrary websites.
4. **Belt-and-suspenders prod assertion:** if a prod-built daemon ever observes `CCSM_DAEMON_DEV_TCP` set in its environment, it MUST log `pino.error("dev TCP listener requested in prod build — ignoring")` AND surface a Settings-pane red banner. The listener still does not bind.
5. **CI smoke test (chapter 08):** L2 contract test on the prod-built daemon binary asserts `nc 127.0.0.1 7878` refuses connection regardless of `CCSM_DAEMON_DEV_TCP`. Listed as a chapter 09 M3 done-definition deliverable.

The same `Host`-header validation and "no JWT-exempt routes" policy applies to the **production** TCP listener (chapter 05 §5) — see chapter 05's fixer pass for the prod-side hardening (R2-P0-2). This chapter only specifies the dev-listener mechanics.

**Why a dev TCP listener at all:** browsers can't speak named-pipe / Unix-socket directly. The proper prod path goes through Cloudflare Tunnel which terminates HTTP/2 on the daemon's TCP listener — but that's what the daemon serves remote traffic on anyway. Reusing the same listener for dev keeps the code path symmetric.

**Why not Vite proxy directly to the named pipe / Unix socket:** Node http2 over Unix socket is doable but proxy-from-Vite-to-named-pipe-on-Win is fragile. TCP is the simpler dev story.

## 5.1. Transport-target injection (dev / test)

The `web/src/transport.ts` module decides at runtime which base URL to talk to. Resolution order:

1. `import.meta.env.VITE_DAEMON_BASE_URL` — set at Vite build/dev time (e.g. `VITE_DAEMON_BASE_URL=http://127.0.0.1:7878 npm run web:dev`). Used by `vite dev`, `vite preview`, and the chapter 08 e2e fixture. Single helper `getDaemonBaseUrl()` reads this.
2. Otherwise: same-origin (`window.location.origin`) — production behavior, served from `app.<author-domain>` via Cloudflare Tunnel.

The chapter 08 §5 web e2e fixture sets `VITE_DAEMON_BASE_URL=http://127.0.0.1:7878` plus the per-launch dev secret in a `<meta>` tag injected at fixture-build time, and the Connect transport reads both. No URL query params, no `window` globals — single, documented build-time mechanism.

## 6. Offline / unreachable UX

**Decision:** show **skeleton + retry banner**, with the banner copy varying by failure cause.

When the web client's Connect transport sees a network or server error:
1. Renderer's `useDaemonHealthBridge` hook (already exists from v0.3 §6.8) flips to `unreachable` state.
2. UI shows a banner whose **copy depends on the Connect error code / HTTP status** so the user knows what to do (R3 P1-3 fold):
   - `unauthenticated` (Cloudflare Access JWT expired / missing) → `auth.required` banner with a "Sign in again" link that triggers a top-level navigation to the Cloudflare Access redirect URL. Cross-ref chapter 07 §4.
   - HTTP `502` / `503` / `504` from the edge (Cloudflare Tunnel down or daemon TCP listener unreachable from cloudflared) → `cloudflare.unreachable` banner with a link to the Cloudflare status page. Cross-ref chapter 05 §1.
   - `unavailable` from the daemon (daemon process not running, just-restarted) → existing `daemon.unreachable` banner with "Retry" + "Reload page" buttons.
   - Other network errors (browser is offline, DNS failure) → `network.offline` banner with "Check your connection" copy.
   All four banner ids live in the existing surface registry from v0.3 §6.8; only the per-cause copy and CTA vary. The bridge surface for the banner is unchanged.
3. Session list / terminal panes render their **skeleton** state (gray boxes, blinking cursor placeholder) — the existing skeleton from v0.3.
4. `daemon.unreachable` banner: "Retry" button calls `transport.reconnect()`, "Reload page" button calls `window.location.reload()`. **Per-platform divergence:** the "Retry" button is shared with Electron (unchanged from v0.3 §6.8); the "Reload page" button is web-only (Electron has no equivalent — browser reload semantics differ from `BrowserWindow.reload()`). Per-platform conditional rendering at the button level; bridge surface unchanged.
5. Auto-retry: exponential backoff capped at 30s (longer than Electron's 5s — web users often have flakier networks). Backoff is silent at debug-level; verbose Connect-Web reconnect noise is suppressed (see §6.5).

**Decision: no offline-data caching in v0.4.** No service worker, no IndexedDB cache of session content. If the daemon is unreachable, the user sees skeleton. Period.

**Why no caching:** stale data is worse than no data for a session/terminal product. A user seeing yesterday's transcript and thinking it's live is a real bug. Defer to v0.5+ if there's clear demand.

**What about the JS bundle itself when offline?** Cloudflare Pages serves with two cache-policy tiers (locked in `web/public/_headers`):

- `index.html`: `Cache-Control: no-cache, must-revalidate` so the user always gets the latest shell hash on each visit.
- `/assets/*-[hash].*` (hashed/immutable bundles): `Cache-Control: public, max-age=31536000, immutable` — standard 1-year immutable caching for content-hashed assets. Returning users skip re-download until the hash changes.

The browser caches the SPA shell, so even with no daemon connectivity the user sees the app chrome + skeleton + banner — not a blank page.

## 6.5. Error reporting

Production debugging requires a path for user-side errors back to the developer. Electron has `~/.ccsm/daemon.log`; the web client gets the equivalent via the daemon (R3 P1-1 fold).

**Mechanism:**
1. Web client installs `window.onerror` and `window.addEventListener('unhandledrejection', ...)` listeners at `web/src/main.tsx` boot.
2. On error: post a `ReportClientError(message, stack, traceId, userAgent, url, ts)` RPC to the daemon. New RPC added to chapter 02 proto inventory and chapter 03 bridge surface (cross-file follow-up tagged for chapter 02/03 fixers).
3. Daemon writes errors to `~/.ccsm/web-client-errors.log` with the same rotation policy as `daemon.log` (cross-ref v0.3 §10).
4. Settings pane gains a hidden "Copy diagnostics" button (visible behind a `?debug=1` query) that copies the last 50 lines of web-client-errors.log to clipboard for paste-back.
5. **No third-party telemetry** (Sentry, etc.) in v0.4 — daemon-side capture is the v0.4 floor; external services are a v0.5+ scope decision.

**Console-noise discipline:** the Connect-Web transport is wrapped with a quiet error handler that logs expected reconnect classes (`unavailable`, network drops during backoff) at `console.debug`, reserving `console.error` for true uncaught crashes. Otherwise the dev console fills with scary red text during normal reconnects.

**xterm.js client-side memory:** browser tabs open for days accumulate xterm scrollback in renderer memory (separate from daemon-side xterm-headless caps). Web client uses xterm.js's default scrollback limit (1000 lines) — same cap as Electron. Page reload clears it. If a user reports tab OOM after multi-day uptime, "reload the tab" is the documented mitigation.

## 7. Browser compatibility target

**Supported:** latest 2 versions of Chrome, Edge, Firefox, Safari (≥ 16), as of release date.

**Why this set:** Cloudflare Access requires modern TLS + cookie handling; older browsers fail at the auth layer anyway. HTTP/2 is universal in modern browsers. ES2022 features (top-level await, class fields) are supported in this target.

**Mobile browsers:** "best effort, not supported." iOS Safari ≥ 16 + Chrome on Android probably work (xterm.js renders, virtual keyboard captures input clumsily). Not in success criteria; not in regression-test scope. See N1 in chapter 01.

**Polyfills:** none. If your browser doesn't have `Intl.DateTimeFormat` and `crypto.subtle`, you're out.

## 8. What's intentionally absent

**No Progressive Web App manifest** — `web/public/manifest.json` is omitted. Adding "install to home screen" is a v0.5+ decision; plumbing it requires icon assets, install-prompt UX, and PWA-specific testing.

**No service worker** — no offline shell, no background sync, no push subscription. See §6 + N8 in chapter 01.

**No SSR / no Cloudflare Workers route handlers** — pure static SPA. The daemon does all the dynamic work; Pages just serves bytes. This keeps Cloudflare-side cost at $0 (free Pages tier) and the architecture trivially debuggable.

**No mobile-first responsive redesign** — A4 anti-goal in chapter 01. Layout works on a 1280×720+ viewport; below that, scrolls horizontally. Don't optimize for phones in v0.4.

**No theme / appearance settings unique to web** — same dark/light theme as Electron, sourced from same Settings RPC. If `prefers-color-scheme` differs between desktop and laptop, that's the user's OS setting on each device — not a bug.

## 8.1. Web client storage / CSP / third-party policy

Three explicit prohibitions to foreclose foot-guns that would otherwise creep in via "harmless" future PRs (folded from R2 P1-1, P1-2, P1-3).

**No persisted client-side storage of auth or RPC data (R2 P1-1):** the SPA MUST NOT persist any auth tokens, JWTs, JWT-derived data, or daemon RPC results to `localStorage`, `sessionStorage`, IndexedDB, Cache Storage, or any other browser persistent store. The JWT lives **only** in the `CF_Authorization` cookie (managed by Cloudflare; chapter 05 §3, chapter 07 §4). In-memory React/Zustand state is the only allowed cache. Rationale: any persisted secret is XSS-exfiltrate-able; xterm.js or a future rich-text component could ship an HTML-injection bug. A CI lint (`grep -r 'localStorage\|sessionStorage\|indexedDB\|caches\.' web/src src/` with allow-list of explicit exceptions) gates the rule on every PR.

**Default Content Security Policy (R2 P1-2):** the SPA ships with a strict CSP enforced via `web/public/_headers` for Cloudflare Pages (and a duplicate `<meta http-equiv="Content-Security-Policy">` in `index.html` for `vite preview` and the e2e fixture). Locked starter:

```text
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';   # xterm.js needs inline styles; verify in M3
connect-src 'self' https://app.<author-domain>;
img-src 'self' data:;
font-src 'self';
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
form-action 'self' https://*.cloudflareaccess.com;
```

Each directive verified against actual SPA needs in M3 before lock. If `'unsafe-inline'` for `style-src` proves avoidable, drop it. CSP is the primary mitigation against XSS post-exploit; missing it = no protection layer if any HTML-injection bug ships.

**No third-party runtime resources (R2 P1-3):** the SPA MUST NOT load any runtime resource (font, script, stylesheet, image, iframe) from a non-same-origin URL. All assets bundled into `web/dist/`. No Google Fonts CDN, no analytics tags, no third-party CSS. Allow-list exception: the Cloudflare Access auth-redirect form-target (`https://*.cloudflareaccess.com`) — already in CSP `form-action`. CI gate parses the built `web/dist/index.html` and any `<link>`/`<script>`/`<img>` src; fail if any non-same-origin URL appears outside the allow-list. Rationale: forecloses supply-chain drift, privacy leaks (third-party CDN sees every page load), and CSP exceptions accumulating one PR at a time.
