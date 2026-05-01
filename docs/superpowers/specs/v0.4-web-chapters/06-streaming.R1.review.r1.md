# Review of chapter 06: Streaming and multi-client coherence
Reviewer: R1 (feature-preservation)
Round: 1

## Findings

### P1-1 (must-fix): §3 PTY input "5ms coalescing window" — clarify whether this is a behavior change vs. v0.3 or a preserved property
**Where**: chapter 06 §3, "Batching at the renderer" paragraph
**Issue**: The spec introduces a 5ms `requestAnimationFrame`-aligned coalescing window for PTY input batching. It justifies the choice ("5ms gives paste batching without adding noticeable per-keystroke delay") but does NOT state whether this is:
- (a) Already present in v0.3 (just being re-described in the v0.4 protocol context), OR
- (b) New behavior in v0.4 (because Connect-Web requires unary-per-message and per-keystroke unary RPCs would be too chatty without batching).

If (a): preserved feature, no action. If (b): this is a renderer behavior change introduced by v0.4 (input is no longer 1:1 with keystroke). Even if the visible effect is below human perception, it is a behavior change in a feature-sensitive code path (PTY input).
**Why P1**: PTY input is a feature-critical code path. Latency budget changes (even sub-frame) sometimes surface as user-visible jitter on slow machines. R1 must verify this is preserved-from-v0.3 and not invented-in-v0.4. If invented, the spec needs to justify under "required by Connect-Web's unary input model" and link to the test that verifies no input is dropped or reordered under the coalescing window.
**Suggested fix**: in §3, add one sentence after the 5ms paragraph: "**Provenance:** v0.3 [already coalesced PTY input at <X>ms / sent each keystroke as a separate envelope frame]. v0.4 [preserves this / introduces 5ms coalescing required by Connect-Web's unary input model; this is the smallest behavioral change consistent with the new transport]." Implementer fills the brackets after grep'ing the v0.3 source.

### P2-1 (nice-to-have): §8 "folded streams" — assert that bridge-emit semantics for `onCwdRedirected` and `onActivate` are preserved bit-for-bit
**Where**: chapter 06 §8, "Why fold related streams" paragraph; also author's open topic per R1 dispatch prompt
**Issue**: §8 folds `cwd_redirected` and `activate` into existing streams as `oneof` variants, with bridge-side fan-out preserving separate listener sets. The chapter says "the bridge surface (`onState`, `onTitle`, `onCwdRedirected`, `onActivate`) stays as separate listener-set fan-outs in the bridge file (per v0.3); the wire surface is the smaller folded set." Good. But it does NOT explicitly state:

1. The bridge MUST emit on `onCwdRedirected` listeners ONLY when the wire variant is `cwd_redirected` (no firing on every `state_change` variant).
2. The bridge MUST NOT introduce additional latency by routing through a folded stream's discriminator.
3. The bridge MUST NOT change the payload shape that listeners receive.

Per author's flagged open topic (R1-relevant), this fold is "transport efficiency, not behavior change" — but the spec needs to make that contract explicit so a fixer/implementer doesn't introduce a subtle re-routing bug.
**Why P2**: the framing is correct; the contract just needs to be tight enough that a reviewer of a future bridge-swap PR can grep for "bridge emits `onCwdRedirected` on any non-cwd_redirected variant" as a regression check.
**Suggested fix**: append to §8 a "**Folded-stream bridge contract**" subsection with the 3 rules above as MUST clauses, and reference it from chapter 03 §4 (bridge surface stability rule).

### P2-2 (nice-to-have): §5 "concurrent inputs from desktop + web" — surface that this is a new observable behavior
**Where**: chapter 06 §5, last paragraph "Concurrent inputs from desktop + web"
**Issue**: The chapter notes "two clients typing simultaneously interleave at character boundaries (just like two people typing on the same shell). This matches user expectations for a 'shared session' model." This is technically a NEW observable behavior in v0.4 (in v0.3 only one client could attach), but it is intrinsic to the +frontend addition (the whole point of having a 2nd client). Chapter 10 R14 covers it as a documentation-only risk. R1 sees this as acceptable but worth a one-line cross-ref to make the "intrinsic to new client, not a feature change" framing explicit.
**Why P2**: cosmetic.
**Suggested fix**: append to §5's last paragraph: "**R1 framing:** this concurrent-input behavior is observable only because v0.4 adds a second client. It is NOT a feature change to single-client behavior (Electron-only behavior is identical to v0.3). Documented as R14 in chapter 10."

## Cross-file findings

None new from R1.
