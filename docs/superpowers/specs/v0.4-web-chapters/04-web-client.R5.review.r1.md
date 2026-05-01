# Review of chapter 04: Web client

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): Dev TCP listener "MUST NOT enable in production" lacks a test gate
**Where**: chapter 04 §5 — "Dev-only TCP listener on the daemon... MUST NOT be enabled in production builds."
**Issue**: this is asserted but no test enforces it. A regression where someone removes the `NODE_ENV` check (or the build flag flips), and the daemon listens on `127.0.0.1:7878` in a release build with no JWT validation, is a silent security failure. Trivially testable: production-build smoke (`require()` the daemon, set `CCSM_DAEMON_DEV_TCP=7878`, assert `EADDRINUSE` or refusal to bind logged).
**Why P1**: the local TCP listener with no JWT is the highest-blast-radius security regression in v0.4. Asserting MUST NOT without a test means the constraint relies on developer vigilance.
**Suggested fix**: chapter 08 §3 adds a contract test: "production build refuses to bind dev TCP listener even when env var is set". Chapter 09 M3 done-definition adds the test as a deliverable.

### P1-2 (must-fix): Shared-renderer drift between Electron and web has no enforcement
**Where**: chapter 04 §2 — "the renderer is the product. Forking it doubles maintenance and guarantees drift."
**Issue**: nothing in the test plan asserts "every renderer file under `src/` is imported by both Electron entry and web entry, with the same module evaluation". Drift creeps in via: (a) Electron-only conditional that doesn't compile in web, (b) renderer file imported by Electron but tree-shaken out of web (silently broken if web later needs it), (c) different `tsconfig` `paths` mapping leading to different module resolution. No spec for a "renderer parity" test.
**Why P1**: chapter 09 M3 dogfood is "3-day, 4-5 hours of real work" — that won't catch slow drift. CI gate is much better.
**Suggested fix**: chapter 08 adds a layer (or extends L4) — a build-time check that diffs the imported file set across Electron and web entries. Catches "this file is in Electron but never reached from web". Cheap and high-value.

### P1-3 (must-fix): Web e2e test fixture's "configures to talk to localhost:7878 via the dev-mode transport" is hand-wavy
**Where**: chapter 04 §5 + chapter 08 §5
**Issue**: chapter 08 §5 says the web client in the test "is configured to talk to localhost:7878 via the dev-mode transport, not via cloudflared". But web/src/transport.ts (chapter 04 §1) is built once per Vite invocation. How the test fixture overrides the transport target is unspecified — env var read at runtime? injected via window global? URL query param? Without a concrete mechanism, the test fixture's behavior is undefined.
**Why P1**: leads to test infrastructure that's bespoke per case, hard to reason about flake.
**Suggested fix**: chapter 04 §5 (or new §5.1) specifies the dev/test transport-target mechanism: env-injected `import.meta.env.VITE_DAEMON_BASE_URL` for `vite dev` / `vite preview`; documented and a single helper.

### P2-1 (nice-to-have): Bundle-size CI gate (R10 mitigation) not yet specified in test plan
**Where**: chapter 04 §2 + chapter 10 R10 mitigation
**Issue**: R10 mitigation says "CI lint: bundle-size check (`size-limit` package) on PRs touching `web/` or `src/`. Fail on >800 KB." Chapter 08 §9 doesn't list this workflow. Without it landing in the test plan, it's a TODO that gets forgotten.
**Why P2**: regression here is gradual, not catastrophic.
**Suggested fix**: chapter 08 §9 adds `bundle-size.yml` row.

## Cross-file findings

- **Dev TCP production gate** (P1-1) cross-refs chapters 04 §5 + 05 §5 + 08 + 09 M3 done-def — same fixer.
- **Web transport-target injection mechanism** (P1-3) lives in 04 §5 but tests rely on it (08 §5).
