# Review of chapter 02: Protocol (Connect + Protobuf + buf)
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P2-1 (nice-to-have): §7 "daemon out of date" banner via `Ping` RPC introduces a new UI surface; flag explicitly
**Where**: chapter 02 §7, "Wire version negotiation" paragraph; also chapter 10 R7 mitigation
**Issue**: The spec adds a `Ping` RPC and says the renderer will "surface a 'daemon out of date' banner if `protoVersion` doesn't match expected". This is a new banner / new UI string in the renderer that did not exist in v0.3. It is technically required (skew detection is intrinsic to a published wire surface) so it is not feature drift, but the spec does not call it out as a permitted-because-required new surface. Chapter 10 R7 even marks it "MAY be deferred to v0.5 if scope tight" — implying it may not even ship in v0.4, which makes its status ambiguous.
**Why P2**: the new banner is reasonable, but per R1 discipline, every new user-visible surface in v0.4 should be explicitly logged as "permitted because <prerequisite reason>" so that future review rounds and the merger can verify the inventory.
**Suggested fix**: in §7, add a one-line note: "**New UI surface (permitted, because:)** the 'daemon out of date' banner is a new renderer string introduced by v0.4 because the published wire surface needs explicit skew detection. It is NOT a feature redesign of the existing daemon-unreachable banner family. If R7's deferral fires (banner not shipped in v0.4), behavior on skew falls back to existing `daemon.unreachable` surface — no other code change needed."

## Cross-file findings

None for R1 from this chapter.
