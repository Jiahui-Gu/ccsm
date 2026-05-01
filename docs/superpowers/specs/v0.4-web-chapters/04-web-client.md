# 04 — Web client (Vite SPA + Cloudflare Pages)

## Context block

The web client is the user-visible payoff of v0.4. Goal: open `https://app.<author-domain>` from any browser, hit Cloudflare Access, sign in via GitHub, and reach the user's daemon over Cloudflare Tunnel. The SPA reuses the same `src/` React renderer code as Electron — same components, same Zustand stores, same xterm.js terminal — packaged through Vite into static assets and deployed to Cloudflare Pages on push to `main`.

## TOC

- 1. Workspace layout (`web/` package)
- 2. Shared renderer packaging
- 3. Vite configuration
- 4. Build pipeline + Cloudflare Pages deploy
- 5. Local development
- 6. Offline / unreachable UX
- 7. Browser compatibility target
- 8. What's intentionally absent (no PWA, no service worker, no responsive redesign)

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

**Bundle size:** Vite + Rollup tree-shake the unused bits. Expected web bundle: ~600 KB gzipped (xterm.js ~200 KB, React ~50 KB, Connect-Web runtime ~30 KB, app code ~300 KB). Cloudflare Pages serves with Brotli; effective wire size ~450 KB. First-load target: <2s on a 5 Mbps connection.

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

**Dev-only TCP listener on the daemon:** controlled by `CCSM_DAEMON_DEV_TCP=7878` env var. **MUST NOT** be enabled in production builds. The dev TCP listener has no JWT validation (no Cloudflare Access in dev) and binds 127.0.0.1 only.

**Why a dev TCP listener at all:** browsers can't speak named-pipe / Unix-socket directly. The proper prod path goes through Cloudflare Tunnel which terminates HTTP/2 on the daemon's TCP listener — but that's what the daemon serves remote traffic on anyway. Reusing the same listener for dev keeps the code path symmetric.

**Why not Vite proxy directly to the named pipe / Unix socket:** Node http2 over Unix socket is doable but proxy-from-Vite-to-named-pipe-on-Win is fragile. TCP is the simpler dev story.

## 6. Offline / unreachable UX

**Decision:** show **skeleton + retry banner**.

When the web client's Connect transport sees `unavailable` / network error:
1. Renderer's `useDaemonHealthBridge` hook (already exists from v0.3 §6.8) flips to `unreachable` state.
2. UI shows the existing `daemon.unreachable` banner (translated string).
3. Session list / terminal panes render their **skeleton** state (gray boxes, blinking cursor placeholder) — the existing skeleton from v0.3.
4. Banner has a "Retry" button that calls `transport.reconnect()` and a "Reload page" button.
5. Auto-retry: exponential backoff capped at 30s (longer than Electron's 5s — web users often have flakier networks).

**Decision: no offline-data caching in v0.4.** No service worker, no IndexedDB cache of session content. If the daemon is unreachable, the user sees skeleton. Period.

**Why no caching:** stale data is worse than no data for a session/terminal product. A user seeing yesterday's transcript and thinking it's live is a real bug. Defer to v0.5+ if there's clear demand.

**What about the JS bundle itself when offline?** Cloudflare Pages serves with `Cache-Control: public, max-age=14400` for hashed assets. The browser caches the SPA shell, so even with no daemon connectivity, the user sees the app chrome + skeleton + banner — not a blank page. This is good enough.

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
