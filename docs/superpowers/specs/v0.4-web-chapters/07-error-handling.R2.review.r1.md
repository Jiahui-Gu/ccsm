# Review of chapter 07: Error handling and edge cases

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): "Auto-redirect loop on JWT misconfig" mitigation is operator-dependent; needs in-app surfacing
**Where**: chapter 07 §2, "Cloudflare Access misconfigured (e.g. wrong AUD claim)"
**Issue**: When AUD mismatch causes loop, the spec says "User checks daemon log, fixes Access app config in Cloudflare dashboard, re-runs setup wizard step 2." This relies on the user noticing the log file and knowing to grep for `jwt_aud_mismatch`. From the user's perspective: the web client appears broken, redirects forever, no error message. They will likely conclude "Cloudflare is broken" and not check daemon logs.

A second concern: the rate-limited log line (`once per minute`) means a determined attacker can probe AUD values at any rate (the log is rate-limited, the *check* is not), and only one probe-attempt per minute appears in logs. Defenders lose visibility.

**Why this is P1**: silent-loop-no-error is a UX failure that escalates to a security failure (operator can't tell misconfig from attack).
**Suggested fix**:
1. Daemon SHOULD surface a `cloudflare.misconfigured: AUD mismatch` banner in the Electron Settings UI when JWT failures with `aud_mismatch` exceed N/minute. User sees the issue without grepping logs.
2. Log EVERY JWT failure with full claim breakdown (rate-limit only the user-visible banner, not the log). Logs are local-only; verbosity here is fine.
3. Distinguish in logs between "no JWT" (misconfig — Tunnel not behind Access) vs "wrong AUD" (config drift) vs "expired JWT" (normal session expiry) vs "invalid sig" (key rotation in flight or attack). Different classes need different responses.

### P1-2 (must-fix): JWT replay accepted (A5) but no compensating audit trail
**Where**: chapter 07 §4 "JWT replay (attacker steals JWT cookie)" + chapter 10 A5
**Issue**: Spec accepts JWT replay because of single-user model (any replay is by attacker-with-user-credentials, indistinguishable from user). But there's NO compensating audit log of "where is this JWT being used from". Cloudflare logs request IPs at the edge; daemon logs (chapter 05 §4) include `jwt_email + traceId` but not `Cf-Connecting-Ip`. A user noticing suspicious activity has no audit trail to confirm "was that me from my home IP, or someone else?"

Additionally: the recovery instructions (chapter 07 §4) — "revoke GitHub OAuth grant ... rotate Access app config" — invalidates the existing JWT only AFTER the existing JWT expires (up to 24h, chapter 05 §3). Cloudflare Access supports session revocation (CF Zero Trust → Sessions → Revoke), which IS instant. Spec should say so.

**Why this is P1**: Recovery story is incomplete; audit story is missing. These are basic operational hygiene.
**Suggested fix**:
1. Every authenticated RPC log line includes `Cf-Connecting-Ip`, `Cf-Ray` (request ID), `jwt_email`, `jwt_iat`, `traceId`. (Cf headers come from Cloudflare's edge through the tunnel; only present on remote ingress.)
2. Daemon emits a desktop-notification/UI banner on "first-seen-IP for JWT in 30 days" — user sees `New device signed in: 203.0.113.5 (San Francisco) — was this you?`
3. Recovery doc (chapter 07 §4) updated: step 1 = revoke active sessions in CF Zero Trust dashboard (instant kill). Step 2-N = rotation.

### P2-1 (nice-to-have): "v0.4 SQLite schema additive only" assumption — security migration may force destructive change
**Where**: chapter 09 §8 "Why no downgrade ... SQLite schema only additively"
**Issue**: If a security fix between v0.4.0 and v0.4.1 requires removing a column (e.g. accidentally-stored plaintext token discovered in M3 dogfood), the additive-only assumption breaks. Spec should note: security-driven schema changes may be destructive; downgrade not supported in those cases.
**Why this is P2**: forward-looking note.
**Suggested fix**: Add to chapter 09 §8: "Security migrations MAY require destructive schema changes (e.g. dropping accidentally-leaked-secret columns). Downgrade not supported across security migrations; v0.4.x → v0.4.x+1 transitions are forward-only."

## Cross-file findings

P1-2 cross-links to chapter 05 §4 (logging change) and chapter 10 A5 (downgrade A5 from "accepted" to "mitigated by audit + Cloudflare session revoke").
