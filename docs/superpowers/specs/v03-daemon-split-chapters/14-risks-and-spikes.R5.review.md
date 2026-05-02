# R5 review — 14-risks-and-spikes.md

## P0
(none — chapter is consolidated, well-structured)

## P1

### P1-14-1. Spike registry vs phase ordering
See chapter 13 P0-13-3. Spikes have no explicit "do this in phase X" attribution. Each spike entry should include "**Phase**: blocks phase N". Currently downstream worker reads 14 to know what spikes exist, then reads 13 to know when, but the linkage is only via narrative ("**P0 milestone: this phase unblocks...**"). Make explicit.

### P1-14-2. [renderer-h2-uds] fallback recommendation
"v0.3 SHOULD ship this bridge for predictability across all OSes." Chapter 15 §4 item 9 asks reviewer to decide. Chapter 08 §4 only describes it as a fallback. Three places, one decision. Pick now (recommend: ship the bridge unconditionally → cuts the spike). See chapter 08 P0-08-2.

### P1-14-3. [worker-thread-pty-throughput] — kill criterion is binary
"any byte loss OR delta seq gap" — strict. Chapter 15 §4 item 1 mentions reviewer should consider mandating `child_process` per session for isolation. Decision deferred. The fallback "child_process per session ... would jeopardize ship-gate (c). Escalate before adopting." So spike outcome === ship-gate decision. Add "**Escalation**: if spike fails, escalate to user before phase 5 starts" — currently implicit.

### P1-14-4. Vague verbs
- §1.1 "acceptable on a single-user dev machine" — fine, qualifier pins scope.
- §1.13 "acceptable" for source-build-bumps-CI-time fallback — pin a budget (e.g. "<+5min").
- §1.6 "the bridge is the most-likely-needed adaptation; v0.3 SHOULD ship this bridge for predictability across all OSes" — see P1-14-2.

### P1-14-5. Cross-chapter bookkeeping
§3 says "Reviewers (stage 2 of the spec pipeline) MUST cross-check that every MUST-SPIKE in this chapter is either (a) explicitly marked unresolved (acceptable for spike-pending phases) or (b) reflected as a definitive choice in the corresponding chapter section."

R5 verification: the 15 spikes appear in chapters as expected. ✓

### P1-14-6. [sea-on-22-three-os] fallback "switch to `pkg`"
`pkg` is in maintenance mode (chapter 14 itself says so). Second fallback is "plain node + bundle.js + node_modules/ zip with launcher script (loses single-file but ships)". OK. But chapter 10 §1 doesn't mention either fallback in §1's main text — only in the spike. If sea fails, chapter 10 §1's "single executable" framing breaks. Add cross-link.

### P1-14-7. [better-sqlite3-in-sea] is named "default expected" to fall back
Wording "Fallback (default expected)" suggests we already know sea can't embed `.node`. If true, this isn't a spike — it's a known limitation. Either (a) restate as "Known limitation: sea cannot embed natives. Strategy: ..." (no spike needed); (b) keep as spike if there's any chance Node 22+ adds native embedding.

## Scalability hotspots
(N/A)

## Markdown hygiene
- All entries follow same structure. Good.
- §2 residual risks table well-formed.
- Internal links use `./N-name.md` relative paths. ✓
