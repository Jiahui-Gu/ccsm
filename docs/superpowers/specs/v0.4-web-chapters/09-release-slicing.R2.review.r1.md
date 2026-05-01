# Review of chapter 09: Release slicing

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): M3 deliverable 5 (dev TCP listener prod gate) is hand-waved — must be locked
**Where**: chapter 09 §4 M3 deliverable 5, "Dev TCP listener on daemon (`CCSM_DAEMON_DEV_TCP=7878`); MUST refuse to bind in production builds (compile-time gate via `process.env.NODE_ENV` check or build flag)."
**Issue**: "compile-time gate via `process.env.NODE_ENV` check OR build flag" leaves the choice to the implementer. Both have failure modes:
- `process.env.NODE_ENV === 'development'`: NODE_ENV is set externally; a packaged daemon launched with `NODE_ENV=development` enables dev listener. Trivial misconfiguration → full bypass.
- "Build flag": better, but spec doesn't say which (`tsconfig` exclude? webpack `DefinePlugin`? `process.env.CCSM_BUILD`?). Without a locked mechanism, fixer or M3 worker picks the easier (and weaker) one.

This is the same concern as chapter 04 R2 P0-1. It needs a concrete lock here in chapter 09 because M3 is where it gets implemented.

**Why this is P1**: see chapter 04 R2 P0-1 (DNS rebinding + local malware). The unauth dev listener is RCE-class.
**Suggested fix**: Lock M3 deliverable 5 to:
1. Dev TCP listener code lives in `daemon/src/dev/dev-tcp-listener.ts`.
2. File is excluded from production builds via `tsconfig.production.json` `exclude: ['src/dev/**']`.
3. Daemon entry imports dev listener via dynamic import gated on `process.env.CCSM_BUILD !== 'production'` AND a `assert.fail()` if both `process.env.CCSM_BUILD === 'production'` AND the dev module is somehow loaded.
4. M3 e2e test (L4) verifies prod-build daemon binary refuses to bind even with `CCSM_DAEMON_DEV_TCP=7878` set.
5. Dev listener requires a per-launch shared secret (per chapter 04 R2 P0-1).

### P1-2 (must-fix): M4 deliverable 4 (keychain encryption) — scheme not locked at the right milestone
**Where**: chapter 09 §5 M4 deliverable 4, "SQLite settings rows for tunnel token, CF team name, CF app AUD; encrypted at rest via OS keychain."
**Issue**: Same as chapter 05 R2 P0-1 — encryption-at-rest scheme not concretely defined. M4 is when this ships; if the spec lands ambiguously, the worker will pick the easier (weaker) interpretation.
**Why this is P1**: ditto chapter 05 P0-1.
**Suggested fix**: Mirror the chapter 05 fix. M4 deliverable 4 should reference chapter 05 §1.X for the locked storage scheme (token in OS keychain only; SQLite contains keyring pointer; Linux fallback documented; setup wizard handling locked).

### P2-1 (nice-to-have): No security checkpoint between M2 and M3
**Where**: chapter 09 §7 dogfood gates
**Issue**: Dogfood gates check functional regression. No explicit "security review" gate between M3 (web client local) and M4 (Cloudflare wired) — yet M3 introduces the dev TCP listener and M4 introduces the entire remote auth surface. A security checkpoint between M3 and M4 (e.g. a dispatched security reviewer audits the JWT interceptor, the keychain integration, the dev-listener gate, the cloudflared spawn args) reduces the chance of M4 shipping with an exploitable gap.
**Why this is P2**: a process suggestion, not a spec mandate.
**Suggested fix**: Add to chapter 09 §7: "Pre-M4 security gate: dispatch a security-focused reviewer to audit (a) JWT interceptor implementation against chapter 05 §4 lock, (b) keychain integration against chapter 05 §1, (c) dev TCP listener prod-gate against chapter 09 M3.5, (d) cloudflared spawn-arg supply-chain checks. Block M4 release if findings."

## Cross-file findings

P1-1 and P1-2 are deferred references to chapter 04 / chapter 05 fixes; one fixer should resolve both chapters together to keep references consistent.
