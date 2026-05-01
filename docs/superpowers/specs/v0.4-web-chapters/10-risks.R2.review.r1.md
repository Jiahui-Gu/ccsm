# Review of chapter 10: Risks

Reviewer: R2 (security)
Round: 1

## Findings

### P1-1 (must-fix): Missing top risk: same-user-local-process compromise of daemon
**Where**: chapter 10 §1-4
**Issue**: The risk inventory does not include "malicious local process owned by the same user can read PTY streams, spawn arbitrary commands, exfiltrate tunnel token, etc." This is the threat model that justifies HMAC-on-local-socket (or its dropping; see chapter 02 R2 P1-1). Either keep HMAC and acknowledge the threat is mitigated, or drop HMAC and acknowledge the threat is accepted — but it MUST appear in the risk inventory.
**Why this is P1**: the risk is real and concrete; readers of the spec should see it called out so they understand the trust model.
**Suggested fix**: Add new risk in §1 or §4:
- **R-NEW (HIGH/MED): Same-user-local-process compromise** — any process running as the daemon's user (compromised dev tool, malicious npm postinstall, exploited browser extension) can connect to the local socket and exercise the full RPC surface (PTY input/output, spawn commands, read settings including tunnel token). v0.3 had HMAC handshake as a second line; v0.4 drops it (chapter 02 §8).
- **Trigger**: any local-malware report on a user's machine.
- **Mitigation**: per chapter 02 R2 P1-1 — either restore HMAC (recommended) or document acceptance and target re-introduction in v0.5.

### P1-2 (must-fix): Missing top risk: GitHub OAuth session compromise = full RCE on user's primary workstation
**Where**: chapter 10 §1
**Issue**: R3 covers Cloudflare-tier-policy-change (vendor risk), but not the more direct compromise scenario: attacker phishes/steals user's GitHub OAuth session, acquires Cloudflare Access JWT, drives the daemon via the web client. With chapter 05 §3's single-factor "include emails" policy and 24h sessions, this is the highest-impact attacker payoff in v0.4 and isn't ranked.
**Why this is P1**: the design's #1 remote-attack vector should be in the top-risk inventory with explicit mitigation cross-refs.
**Suggested fix**: Add new risk in §1:
- **R-NEW (HIGH): GitHub OAuth session compromise → daemon RCE** — attacker who acquires a valid GitHub session for the author's email gets a Cloudflare Access JWT, can drive any RPC including PTY input (= shell command execution).
- **Trigger**: GitHub security advisory, suspicious sign-in notification from GitHub or Cloudflare, unexplained PTY activity in daemon logs.
- **Mitigation**: per chapter 05 R2 P0-2 — require Cloudflare Access MFA, reduce session duration, daemon-side IP audit, documented compromise-recovery flow.

### P1-3 (must-fix): A5 (JWT replay accepted) — re-evaluate against the recovery story
**Where**: chapter 10 §4 A5
**Issue**: A5 says "Attacker who has the JWT cookie has the same identity as the legitimate user" — true in single-user model. But this masks two distinct concerns: (a) attacker uses the JWT IS the same as user using it, fine; (b) the user has no way to *detect* which case is happening. Without daemon-side IP audit (chapter 07 R2 P1-2), the user can't distinguish their own use from attacker's. So "no defense" is an acceptance of an undetectable compromise, which is materially worse than "no defense, but you'll see it."
**Why this is P1**: re-frame the acceptance to be honest about its consequence.
**Suggested fix**: Reword A5: "JWT replay-mid-validity not prevented, but daemon logs every authenticated RPC's source IP + Cf-Ray + jwt-iat (per chapter 07 R2 P1-2 + chapter 05 §4); user can audit. Cloudflare's session-revoke endpoint provides instant invalidation if compromise suspected."

### P2-1 (nice-to-have): R9 (cloudflared supply chain) understated — pin mechanism vague
**Where**: chapter 10 §2 R9
**Issue**: Mitigation is "Pin `cloudflared` version in build script". Spec doesn't say SHA-pinning + signature verification (see chapter 05 R2 P1-1).
**Why this is P2**: covered in chapter 05 review.
**Suggested fix**: Update R9 to reference chapter 05 §1.X locked supply-chain story.

### P2-2 (nice-to-have): No risk for "user's machine compromised → CF tunnel token exfiltrated → attacker rebinds tunnel"
**Where**: chapter 10
**Issue**: Even with strong remote auth, if the user's machine is compromised (RCE via any vector), the tunnel token is exfiltrated. Attacker spawns own `cloudflared` with the token → user's tunnel hostname now routes to attacker. User can't tell (DNS still points to Cloudflare; Cloudflare proxies to whichever cloudflared connected most recently / is healthy).
**Why this is P2**: low likelihood, hard to mitigate in v0.4.
**Suggested fix**: Add to §3 or §4:
- **R-NEW (LOW)**: Tunnel-token exfiltration → tunnel hijack. If user's machine is compromised, attacker can run their own cloudflared with the same token, intercepting tunnel traffic.
- **Mitigation**: (a) Cloudflare dashboard shows active tunnel connections; user can audit. (b) Token rotation on every dogfood window. (c) Future: Cloudflare-side connection-fingerprinting alert.

## Cross-file findings

R1-1 needs chapter 02 R2 P1-1 to land first (decide HMAC or no-HMAC); risk wording follows.
R1-2 needs chapter 05 R2 P0-2 mitigations (MFA, reduced session, audit) to land first; risk text describes the post-mitigation residual risk.
