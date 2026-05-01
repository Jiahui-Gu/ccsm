# Review of chapter 04: Web client (Vite SPA + Cloudflare Pages)

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

### P1-1 (must-fix): Bundle-size estimate is best-case; no enforcement before M3 close
**Where**: chapter 04 §2 ("Bundle size: ~600 KB gzipped... First-load target: <2s on a 5 Mbps connection.") and chapter 10 R10.
**Issue**: The 600 KB target is plausible but optimistic. Realistic accounting for current `src/`:
- React + ReactDOM (~50 KB gzipped) ✓
- xterm.js + addons (`-fit`, `-web-links`, possibly `-search`) — closer to **~250 KB gzipped** when scrollback and addons are pulled in, not 200.
- Connect-ES runtime (`@connectrpc/connect` + `@connectrpc/connect-web`) **~45-60 KB gzipped**, not 30.
- **`@bufbuild/protobuf` runtime** is omitted from the table entirely. It's mandatory for any generated code and runs ~25-40 KB gzipped.
- `gen/ts/` runtime stubs scale with RPC count: 46 RPCs × ~1-2 KB stub each → **~50-90 KB gzipped** addition.
- Zustand, i18n bundles, framer-motion (per memory: design uses it), Radix primitives — none accounted for.
- App code "~300 KB" is a guess — the v0.3 renderer hasn't been measured.

Realistic v0.4.0 first-load is more like **800-1100 KB gzipped**. Chapter 10 R10's mitigation says "CI lint: bundle-size check on PRs touching `web/` or `src/`. Fail on >800 KB. Lock-in for M3 PR." — but the threshold is set BELOW likely actuals, meaning either the gate trips immediately on M3 or it gets relaxed. Either way the 2s/5Mbps target is at risk.
**Why P1**: First-load latency is the dominant web UX metric; spec's stated budget will not survive M3. Need to either pre-measure or pre-commit to a real threshold.
**Suggested fix**:
1. Run a one-day spike at M1 to bundle the current `src/` against the proto stubs and **measure**. Lock the §2 number to actual + 20% headroom.
2. Add `size-limit` config to M1 deliverables (chapter 09 §2), not M3 (chapter 09 §4) — gate the bundle from day one when growth is small.
3. Drop xterm `-search` and any addon not strictly required.
4. Be explicit about whether the SPA is **code-split** for the terminal route (lazy-load xterm) — currently §3 manual chunks split for caching, NOT for lazy load. If the session-list page is the landing page, terminal chunk should defer.

### P1-2 (must-fix): Dev TCP listener is a perf+security cliff; spec doesn't gate the prod-build symbol
**Where**: chapter 04 §5 ("Dev-only TCP listener on the daemon: controlled by `CCSM_DAEMON_DEV_TCP=7878` env var. **MUST NOT** be enabled in production builds.") and chapter 09 §4 deliverable 5 ("MUST refuse to bind in production builds (compile-time gate via `process.env.NODE_ENV` check or build flag).").
**Issue**: A runtime `process.env.NODE_ENV` check is the wrong gate — it doesn't tree-shake out of the daemon binary. The TCP-listener code path stays in the production bundle, lives in the same process, and is one mistakenly-set env var away from binding. From a perf angle this is also bad: the dev path uses HTTP/1.1 → HTTP/2 conversion shim (described in §5) which is a measurably slow path; if it's ever accidentally used in prod (e.g. someone `export CCSM_DAEMON_DEV_TCP=7878` for debugging on their actual install) the user silently runs in slow + insecure mode without notice.
**Why P1**: Either enables a DoS / unauth surface in production, or — at best — degrades perf invisibly. Either is unacceptable for a "remote access" product.
**Suggested fix**:
1. Replace runtime check with **build-time** symbol via `define: { __DEV_TCP_ENABLED__: false }` in the production daemon's build (esbuild/pkg). Dead-code-eliminates the listener entirely.
2. If runtime path is kept for dev convenience, daemon MUST log `pino.error` AND surface a Settings-pane red banner the moment the listener binds in any prod context (binary built with `--prod`).
3. Bind only after a 5-second startup delay so a smoke test can detect "daemon shouldn't be on 7878 in prod".

### P2-1 (nice-to-have): Cloudflare Pages cache headers under-specified for streaming SPA
**Where**: chapter 04 §6 ("Cloudflare Pages serves with `Cache-Control: public, max-age=14400` for hashed assets.").
**Issue**: 14400s = 4 hours is short for hashed (immutable) assets. Standard practice is `max-age=31536000, immutable` for hash-named assets and `max-age=0, must-revalidate` for `index.html`. The 4h figure means a returning user every 4h re-downloads the bundle even though the hash hasn't changed.
**Why P2**: Wastes user bandwidth, doesn't break anything.
**Suggested fix**: Two cache rules, one for `index.html` (no-cache), one for `/assets/*-[hash].*` (1y immutable). Configured via Pages `_headers` file, not just default.

### P2-2 (nice-to-have): No mention of Vite chunk-split sizes; manualChunks block can grow unbounded
**Where**: chapter 04 §3 vite config.
**Issue**: `manualChunks` ships three named groups. Vite/Rollup will additionally emit per-route chunks. No upper bound on chunk count means CDN waterfall on first load (HTTP/2 mitigates but doesn't eliminate). No `build.chunkSizeWarningLimit` configured.
**Why P2**: Optimization opportunity; not a launch blocker.
**Suggested fix**: Add `build.chunkSizeWarningLimit: 600` and an upper-bound count check in CI ("≤8 chunks").

## Cross-file findings

**X-R4-C** (with chapter 02 R4-2): `gen/ts/` vendoring policy directly affects web bundle size — every proto runtime stub ships to the browser. Consider whether the web build should re-generate from `proto/` at build time (smaller, only what's used) instead of importing from the vendored `@ccsm/proto-gen`. Single fixer per the policy decision.
