# Review of chapter 07: Error handling and edge cases

Reviewer: R5 (Testability)
Round: 1

## Findings

### P1-1 (must-fix): JWT-expiry mid-session redirect flow has no hermetic test
**Where**: chapter 07 §4 + chapter 08 §5 (`web-jwt-expiry`)
**Issue**: chapter 08 §5 lists `web-jwt-expiry` as a case ("force JWT expiry, assert redirect-to-login flow"). The mechanism for "force expiry" is unspecified. Real CF Access JWTs expire 24h after issue — no test should wait 24h. Need (a) test-mode JWT minted with `exp` 5s in future, (b) the SPA's transport-interceptor catches `unauthenticated` and triggers the redirect-flow path, (c) test fixture catches the redirect navigation and either follows it (real flow) or stubs it (mock flow). None of this is spelled out.
**Why P1**: without spec, the test will be implemented inconsistently or skipped quietly.
**Suggested fix**: chapter 07 §4 adds a "Testability" sub-bullet: test-mode JWT minted with short expiry; SPA transport interceptor's redirect path is exposed for test injection (e.g. `onAuthRedirect: (url) => void` callback hook); test fixture asserts callback fires with the documented URL pattern.

### P1-2 (must-fix): Daemon-disk-full path inherits v0.3 banner but not tested for web client
**Where**: chapter 07 §1 — "Daemon disk full"
**Issue**: "v0.4: same banner reaches both Electron and web (it's in the renderer; both clients render it)". This assumes the `storage.full` event flows through Connect to web. If chapter 06's stream-folding (§8) accidentally drops `storage.full` from `streamSessionStateChanges`, web users won't see the banner. Easy to test (force disk-full simulation in daemon, assert event appears on web e2e), but not in chapter 08.
**Why P1**: regressions in cross-client surface registry are exactly what the multi-client design is supposed to eliminate. Test gap means we won't know if it works.
**Suggested fix**: chapter 08 §5 adds `web-disk-full-banner` case using an injectable disk-full simulation hook on the daemon.

### P1-3 (must-fix): Wire skew "Electron v0.3 vs daemon v0.4" testable but un-specified
**Where**: chapter 07 §5 — "Outcome: Electron's bridge sees connection failure"
**Issue**: this is a documented expected behavior — the older client gets `daemon.unreachable`, not silent corruption. Should be a one-time test (CI matrix one-off): boot a v0.3.x Electron against a v0.4 daemon container, assert the renderer shows `daemon.unreachable`, no crash. Otherwise we're trusting the negative claim with no evidence.
**Why P1**: if the v0.3 envelope client manages to corrupt the v0.4 daemon's HTTP/2 listener somehow (e.g. HTTP/2 connection-preface mismatch crashes the listener), all v0.4 users on the daemon are affected. Worth one CI run.
**Suggested fix**: chapter 08 §3 (or new §3.1) adds "Wire-skew compat smoke" — once-per-release test: spin up old-version client probe against new-version daemon, assert clean rejection.

### P2-1 (nice-to-have): JWT replay test (negative case for single-user model)
**Where**: chapter 07 §4 + chapter 10 A5
**Issue**: §A5 explicitly accepts no-replay-protection for single-user. Worth a test asserting "captured JWT replays from a different IP succeed" so the documented behavior is at least exercised once (catches a future change that accidentally adds nonce-checking and breaks single-user assumption silently).
**Why P2**: documents accepted behavior; not a correctness concern.
**Suggested fix**: chapter 08 §3 adds a one-liner.

### P2-2 (nice-to-have): "Cloudflare misconfigured loop" test
**Where**: chapter 07 §2 — Cloudflare Access misconfigured (wrong AUD)
**Issue**: documented as a redirect loop with rate-limited daemon log. Could be tested via mock JWKS minting a JWT with wrong `aud`, asserting the daemon log contains exactly one warning per ≥minute window across N requests. Verifies the rate-limit isn't broken.
**Why P2**: log spam regression, not a correctness break.
**Suggested fix**: chapter 08 §3 contract test entry.

## Cross-file findings

- **JWT-expiry hermetic test** (P1-1) cross-refs chapters 05 §3 (24h session) + 07 §4 + 08 §5 — same fixer.
- **Wire-skew compat smoke** (P1-3) chapters 02 §7 + 07 §5 + 08.
