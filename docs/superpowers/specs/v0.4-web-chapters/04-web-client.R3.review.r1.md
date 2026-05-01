# Review of chapter 04: Web client

Reviewer: R3 (Reliability / observability)
Round: 1

## Findings

### P1-1 (must-fix): No web-client error reporting / telemetry path

**Where**: chapter 04 (entire chapter).
**Issue**: Chapter 04 has no mention of how user-side errors (uncaught renderer exceptions, Connect transport failures, xterm crashes) surface back to the developer. Electron has `~/.ccsm/daemon.log`; web has no equivalent. If user reports "the page goes blank sometimes", developer has zero data to investigate. Spec explicitly rejects PWA/cache (§8) and SSR (§8) but doesn't address the basic question: where do web errors go?
**Why this is P1**: production debugging is impossible without it. The spec's "trust CI mode" assumes CI catches issues but real-user network/browser combinations are not in CI matrix.
**Suggested fix**: Add §6.5 "Error reporting": minimum viable = (a) `window.onerror` + `unhandledrejection` listeners post errors to a daemon RPC `ReportClientError(message, stack, traceId, userAgent)`, (b) daemon logs to `~/.ccsm/web-client-errors.log` with rotation, (c) hidden settings to enable on-screen "copy diagnostics" button users can paste back. Sentry/external is over-scope for v0.4; daemon-side capture is the v0.4 floor.

### P1-2 (must-fix): Dev TCP listener "MUST NOT bind in production" — enforcement mechanism vague

**Where**: chapter 04 §5.
**Issue**: Spec says "controlled by `CCSM_DAEMON_DEV_TCP=7878` env var. MUST NOT be enabled in production builds." Enforcement is hand-wavy — "compile-time gate via `process.env.NODE_ENV` check or build flag" is cited only in chapter 09 §4 deliverable 5 ("compile-time gate"). If the env-var check survives in the prod binary, an attacker (or user mistake) setting the env var exposes an unauth'd Connect HTTP/2 surface on 127.0.0.1.
**Why this is P1**: this is reliability-and-security crossover. Without a hardcoded build constant (e.g. `if (DEV_TCP_BUILD) { ... }` removed by Rollup tree-shake), the surface ships in prod silently. v0.3 has similar gates that were violated historically.
**Suggested fix**: Specify the gate as a `define` constant (`__CCSM_DEV_TCP_ENABLED__: false` for prod builds, true for dev), tree-shaken at build time. Add a CI smoke (chapter 08) on the prod-built daemon binary asserting `nc 127.0.0.1 7878` refuses connection regardless of env-var. Strict belt-and-suspenders.

### P1-3 (must-fix): "Auto-retry indefinite" — no UI surfacing of progress / failure cause

**Where**: chapter 04 §6.
**Issue**: `useDaemonHealthBridge` flips to "unreachable" + skeleton + retry button + 1s→30s exp-backoff. But the spec doesn't differentiate failure CAUSES surfaced to the user: (a) Cloudflare Access redirect needed (JWT expired, chapter 07 §4), (b) Cloudflare Tunnel down (`cloudflare.unreachable`, chapter 05 §1), (c) daemon down (`daemon.unreachable`), (d) transient network drop. User sees one banner regardless. Misclassification means user can't self-help (e.g. they think it's their wifi when actually they need to re-auth GitHub).
**Why this is P1**: support burden + bad UX. Each cause has a different user action.
**Suggested fix**: §6 differentiate based on Connect error code: `unauthenticated` → JWT expired banner with "sign in" link; HTTP 502/503 → Cloudflare layer banner with status link; network error → "check your connection" banner; `unavailable` from daemon → daemon-restart banner. All map to distinct existing surface registry entries (cross-ref v0.3 §6.8).

### P2-1 (nice-to-have): xterm.js memory growth in long-lived browser tab not addressed

**Where**: chapter 04 §6 + cross-ref chapter 06 §5 + chapter 10 R5.
**Issue**: A web client tab open for days accumulates xterm.js scrollback in browser memory (separate from daemon-side xterm-headless cap). Browser tab can hit OOM. Spec mentions daemon-side caps but not client-side. Risk surfaces as "tab crashes after 3 days of work."
**Suggested fix**: Cite xterm.js's own scrollback limit (default 1000) and confirm web client uses the same cap; document "page reload clears it". One sentence in §6.

### P2-2 (nice-to-have): No mention of browser console-noise discipline

**Where**: chapter 04 §6.
**Issue**: Connect-Web's default behavior on stream loss is verbose console errors. In a normal v0.4 session a user's console will be peppered with errors during reconnects. Visually loud and obscures real issues.
**Suggested fix**: Wrap Connect transport with a quiet error handler that logs at debug-level for expected reconnect classes; reserves console.error for true crashes.

## Cross-file findings (if any)

- **Reconnect cause differentiation (P1-3)** spans chapter 04 §6 + chapter 05 §1 (Cloudflare banner) + chapter 07 §2-§4 (each failure case). Single fixer recommended to align banner taxonomy.
- **Web error reporting (P1-1)** depends on a new RPC `ReportClientError` — need addition to chapter 02 proto inventory + chapter 03 bridge surface.
