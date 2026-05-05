# R1 review of 00-overview — feature-preservation (round 2)

Reviewer: R1 (feature-preservation)
Round: 2

## Round-1 closures

- **[P2 §2 "audit promotes them"]** — not actioned (P2 deferred per fix-plan); status unchanged. Acknowledged.
- **[P2 §3.4 sigkill iron rule scope creep]** — **CLOSED** by CF-3 (commit `1cdba493`). §3.4 rewritten to explicitly bound v0.3 scope = "v0.2 baseline restoration only" with an explicit v0.4 defer list (60s TTL pin / 1MB cap / cwd-mismatch / NEW Set A promotion / G10 release-gate lock). Wording cites "R1 strict-preservation派 prevails (manager decision, round 1)". Matches manager round-1 拍板 #1 verbatim.

Both round-1 R1 P2 findings on this chapter were either deferred (P2) or addressed (P2 promoted via CF-3). No P0/P1 in round 1.

## Round-2 findings

(none)

## Verdict

CLEAN. ch00 §3.4 + §3.7 (daemon liveness, F-00 commit `67452b19`) form a coherent iron-rule set; no NEW P0/P1 introduced by round-1 fix.
