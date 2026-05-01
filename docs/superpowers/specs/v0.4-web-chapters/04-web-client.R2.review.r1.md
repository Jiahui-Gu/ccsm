# Review of chapter 04: Web client

Reviewer: R2 (security)
Round: 1

## Findings

### P0-1 (BLOCKER): Dev TCP listener (`127.0.0.1:7878`) has NO authentication — any local process or browser tab on the dev machine can drive the daemon
**Where**: chapter 04 §5, "Dev-only TCP listener on the daemon: controlled by `CCSM_DAEMON_DEV_TCP=7878` env var. MUST NOT be enabled in production builds. The dev TCP listener has no JWT validation (no Cloudflare Access in dev) and binds 127.0.0.1 only."
**Issue**: "binds 127.0.0.1 only" is **not** a security boundary on a multi-process desktop. Any process running as any user on the same machine — including any browser tab running attacker-controlled JS via DNS rebinding or via a malicious npm postinstall script — can connect to `127.0.0.1:7878` and drive the full Connect surface (spawn PTY, exfiltrate session content, read settings including the encrypted-but-now-RPC-accessible tunnel token, type into existing sessions). DNS rebinding specifically defeats the "browser only allows same-origin" assumption for `localhost`: an attacker page sets a 1s-TTL DNS record to its IP, then to 127.0.0.1; browser allows the second-resolution origin to fetch the first's URLs.

The chapter then says (chapter 05 §5) the **production** TCP listener (also `127.0.0.1:7878`) is JWT-protected — but the dev listener is the same address with NO auth, distinguished only by an env var. A developer who forgets to unset `CCSM_DAEMON_DEV_TCP` in a production daemon binary, OR a packaged build that accidentally includes the dev path, OR a user who is socially engineered to set the env var, exposes the daemon completely.

Worse: chapter 03 §3 envisages the *Electron* renderer talking to the daemon over the local socket (named pipe / Unix socket), and chapter 04 §5 envisages the *web dev SPA* talking over the dev TCP listener. There's no design statement that the dev TCP listener is gated on `NODE_ENV === 'development'` at compile time, or that the dev path is fully removed from packaged binaries. Chapter 09 M3 deliverable 5 hand-waves "compile-time gate via `process.env.NODE_ENV` check or build flag" without locking the mechanism.

**Why this is P0**: an unauthenticated localhost-bound RPC surface in a desktop app is a textbook RCE pivot. The combination of (a) the dev TCP listener exists, (b) the production TCP listener uses the same port and same code path with only an interceptor in front, (c) the gate mechanism is "TBD compile-time check" creates a high probability that someone ships a daemon with the dev path live. DNS rebinding makes this exploitable from any browser the user visits.
**Suggested fix**: 
1. Production daemon binary MUST NOT contain the dev-listener code path — gated by a build-time flag (`process.env.CCSM_BUILD === 'production'` checked at top of `dev-tcp-listener.ts`, file is `tsconfig` excluded from prod build, or wrapped in `if (process.env.NODE_ENV !== 'production')` immediately followed by an unconditional `throw new Error('dev listener loaded in prod')` if the env reads inconsistent). Make this concrete in the spec, not "MAY".
2. Dev TCP listener MUST require a per-launch random shared secret (printed to dev console, sent by SPA as a header). Even in dev, raw 127.0.0.1 binding with no auth is unacceptable due to DNS rebinding.
3. Dev TCP listener MUST validate `Host` header strictly equals `localhost` or `127.0.0.1` to defeat DNS rebinding (rejects any other Host).
4. Lock chapter 04 §5 with an explicit `MUST` line on each of (1)(2)(3); add a chapter 08 test (L2 contract test or L4 web e2e) verifying the prod build of the daemon refuses to bind on `CCSM_DAEMON_DEV_TCP`.

### P0-2 (BLOCKER): Production TCP listener `127.0.0.1:7878` exposed to all local processes; JWT is the only auth — DNS rebinding lets a browser tab bypass it
**Where**: chapter 04 §5 + chapter 05 §5, prod TCP listener bound to `127.0.0.1:7878` and protected by JWT.
**Issue**: Even in production, the JWT-protected TCP listener is reachable by any local process. JWT requires a valid `Cf-Access-Jwt-Assertion` header — that's the only barrier. Two attack paths:
1. **Local malware (same-user)**: any process the user runs (npm install postinstall, malicious VS Code extension, browser tab with a Service Worker fetching `http://127.0.0.1:7878/...`) can connect to the listener. JWT blocks unauthenticated requests. **However**, if the user has a valid `CF_Authorization` cookie open in a browser tab, a malicious page can issue `fetch('https://app.<author-domain>/...', { credentials: 'include' })` and exfiltrate via the public tunnel — but THAT is gated by SameSite=Lax (chapter 07 §4). The local `127.0.0.1:7878` path doesn't go through Cloudflare so cookies don't apply, and JWT would have to be present in headers. Local malware doesn't have it (kept by browser), so this attack is mitigated.
2. **DNS rebinding from arbitrary websites**: an attacker website resolves `attacker.example` to its own IP (serves SPA), then to `127.0.0.1`. Browser same-origin policy considers post-rebind requests same-origin to attacker. Attacker JS fetches `http://attacker.example:7878/ccsm.v1.Ccsm/SpawnPty` — Host header is `attacker.example`, not `localhost`. Without a Host-header validation in the daemon, this passes the JWT check too IF the attacker can also obtain a JWT (they cannot unless user is already logged in to Cloudflare Access — but if user has a valid cookie for their own app, the attacker can't read it cross-origin... so JWT presence is the protection here). The attack reduces to: attacker fetches without JWT → daemon rejects. Safe-ish, but the design relies entirely on JWT presence; if any future code path skips the JWT interceptor (e.g. a `/healthz` endpoint added to TCP listener), DNS-rebind exploit is one fetch away.

**Why this is P0**: Single missed interceptor on TCP listener = full local RPC surface to any browser. The risk is concrete enough that the spec must mandate Host-header validation as belt-and-suspenders.
**Suggested fix**:
1. Production TCP listener MUST validate request `Host` header strictly equals `127.0.0.1:7878` or `localhost:7878` (or the cloudflared-set Host); reject all others with 421 Misdirected Request before any handler runs. This defeats DNS rebinding.
2. JWT interceptor MUST be applied to ALL routes on TCP listener (no allowlist exemptions). State as a hard rule in chapter 05 §4: "no route on the remote TCP listener is exempt from JWT validation."
3. Bind TCP listener to a UNIX-domain socket OR loopback-only with explicit `sysctl`-confirmed local-only routing where possible; on Win, consider named-pipe-only and have `cloudflared` proxy to the named pipe instead of TCP. Investigate whether `cloudflared --url unix:///tmp/...` is supported.

### P1-1 (must-fix): Web client offline + no-credential-storage policy is implicit — must be explicit
**Where**: chapter 04 §6, chapter 05 §3 (JWT delivery via cookie)
**Issue**: Spec says SPA treats JWT as opaque (chapter 05 §3) and "no service worker, no IndexedDB cache" (chapter 04 §8). But it doesn't say the SPA MUST NOT store any auth-relevant data in `localStorage` / `sessionStorage` / IndexedDB. Without an explicit prohibition, a future PR could land a "remember session list" feature that writes to localStorage, which is XSS-readable. Combined with any XSS bug (xterm.js HTML rendering, copied terminal output rendered as HTML somewhere) → credential exfiltration.
**Why this is P1**: Defense-in-depth requirement that's easy to state and forecloses a future foot-gun. Browser-cached SPAs are XSS-targets; any persisted secret is exfiltrate-able.
**Suggested fix**: Add to chapter 04 §8 (or §6): "Web client MUST NOT persist any auth tokens, JWTs, JWT-derived data, or daemon RPC results to `localStorage`/`sessionStorage`/IndexedDB. JWT lives only in the `CF_Authorization` cookie (managed by Cloudflare). Renderer in-memory state is the only allowed cache." Also add a CI lint (`grep -r 'localStorage\|sessionStorage\|indexedDB' web/src src/` allow-listed exceptions only).

### P1-2 (must-fix): Default Content Security Policy for the SPA not specified
**Where**: chapter 04 §3 Vite config, chapter 04 §8, chapter 10 R8 (CSP risk)
**Issue**: Chapter 10 R8 acknowledges CSP risk but the spec doesn't lock a default CSP for the served SPA. Without an explicit CSP, an XSS in the renderer (xterm escape-sequence injection, an HTML-rendering component, future-added rich text) has full exfiltration capability. The web build's `index.html` should ship with a strict CSP via `<meta http-equiv="Content-Security-Policy">` or via Cloudflare Pages `_headers` file. Same for the Electron renderer (already covered by Electron defaults, but worth cross-ref).
**Why this is P1**: CSP is the primary mitigation against XSS post-exploit. Missing in v0.4 = no protection layer if any HTML-injection bug ships.
**Suggested fix**: Add to chapter 04 §3 a CSP block:
```
default-src 'self';
script-src 'self';
style-src 'self' 'unsafe-inline';  # xterm needs inline styles; verify
connect-src 'self' https://<tunnel-host>;
img-src 'self' data:;
font-src 'self';
object-src 'none';
base-uri 'self';
frame-ancestors 'none';
form-action 'self' https://*.cloudflareaccess.com;
```
Locked via `web/public/_headers` for Cloudflare Pages. Verify each directive against actual SPA needs in M3.

### P1-3 (must-fix): No third-party-resource policy stated for the SPA — silent fonts/analytics/CDN imports are a future supply-chain risk
**Where**: chapter 04 §8, chapter 10 R10 (bundle size), chapter 11 §8 (deps)
**Issue**: Spec doesn't state "SPA MUST load all assets from same origin (no Google Fonts CDN, no analytics, no third-party CSS)". A future PR could add `<link rel="stylesheet" href="https://fonts.googleapis.com/...">` for a font, opening a CSP exception, a third-party trust dependency, and a privacy leak (Google sees every page load).
**Why this is P1**: Easy to state, forecloses drift.
**Suggested fix**: Add to chapter 04 §8: "SPA MUST NOT load any runtime resource from a non-same-origin URL. All fonts, scripts, styles, images bundled into `web/dist/`. CI gate: parse `web/dist/index.html` for any `https://` `<link>`/`<script>` and fail if present (allow-list cloudflareaccess.com if needed for the auth redirect)."

### P2-1 (nice-to-have): SPA bundle should use Subresource Integrity (SRI) for any stable chunks
**Where**: chapter 04 §3 (manual chunks for xterm/react/connect)
**Issue**: Vendored chunks served by Pages are trusted by browser by URL only. If Pages is compromised mid-deploy or attacker substitutes a chunk, no SRI hash check fires.
**Why this is P2**: Cloudflare Pages compromise is low-likelihood; SRI on internal-only assets is unusual but cheap.
**Suggested fix**: Add Vite plugin to emit `integrity` attributes on `<script>` tags for the manual chunks. Defer to v0.5 if scope tight.

## Cross-file findings

P0-1 (dev TCP listener) and P0-2 (prod TCP listener Host header / JWT-only) span chapters 04 + 05 + 09 (M3 deliverable 5 needs to lock the build-time gate). One fixer should own both chapters' edits.
