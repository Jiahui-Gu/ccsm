# Review of chapter 11: References

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P1-1 (must-fix): "(T15)" in row label is opaque; chapter has no glossary

**Where**: §2 line 35: "`daemon/src/sockets/data-socket.ts` | Data-socket transport **(T15)** | M1-M2: ..."
**Issue**: "T15" appears with no expansion. Same problem as flagged in 02 §6 with "after T14". A reader of chapter 11 (the references chapter — supposed to be the lookup table) cannot resolve T15 from this spec. If T15 is a v0.3 plan task ID, it should be cited as such.
**Why P1**: chapter 11 is the canonical lookup; opaque labels here propagate elsewhere.
**Suggested fix**: drop "(T15)" or replace with "(created in v0.3 plan task T15 — see `docs/superpowers/specs/v0.3-fragments/`)". Same fix for 02 §6 "after T14".

### P2-1 (nice-to-have): References list mixes "frag-X-...md" filenames with "v0.3 §X" section refs without index

**Where**: §1 lists fragment files (`frag-3.4.1-envelope-hardening.md` etc.). Body of other chapters cites "v0.3 §3.4.1" or "v0.3 §3.1.1" without explicitly linking these to the fragment files.
**Issue**: implicit mapping ("v0.3 §3.4.1" → `frag-3.4.1-envelope-hardening.md`) is conventional but not stated. Reader could miss it.
**Suggested fix**: add one sentence at top of §1: "v0.3 spec section refs in other chapters (e.g. 'v0.3 §3.4.1') correspond to fragment files named `frag-X.Y.Z-*.md` here. Section refs without a fragment match (e.g. 'v0.3 §6') refer to `v0.3-daemon-split.md`."

### P2-2 (nice-to-have): External-doc URLs are markdown-bare, not linked

**Where**: §6 lists URLs as bare `https://...` strings (e.g. line 99 "Tunnel: https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/").
**Issue**: in markdown rendering, these auto-link in most viewers but not all (some renderers require `<https://...>` or `[text](url)` form). Inconsistent with chapter 04 §4 line 126 / chapter 05 §6 lines 161, 162 which also have bare URLs in code/prose.
**Why P2**: minor; auto-link works in GitHub.
**Suggested fix**: optional; if normalizing, use `[Tunnel docs](https://developers.cloudflare.com/...)` form for visible link text + cleaner reading.

## Cross-file findings (if any)

- P1-1 ("T15") bundles with 02 P1-2 ("T14") — same fixer.
