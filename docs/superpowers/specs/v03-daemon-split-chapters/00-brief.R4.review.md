# 00 — Brief — R4 (Testability + Ship-Gate Coverage)

Brief chapter is input-only (per §0 of the brief itself: "Author Brief (input only, NOT a chapter)"). R4 still notes one structural finding because subsequent chapters inherit it.

## P1 — Brief §11(a) "or only in dead-code paths flagged for removal" creates an unimplementable allowance

Per chapter 08 R4 (P0) and chapter 12 R4 (P0): the grep gate as designed cannot represent dead-code allowlists. Spec author should either:
- Push back on brief and ask for the allowance to be dropped (clean grep, no exceptions), OR
- Implement an allowlist file mechanism and pin the format

This is not a finding against the brief per se (briefs are inputs) but it's an inherited burden the spec must resolve and currently doesn't.

## P1 — Brief §11(d) is Win-only; spec inherits asymmetric ship-gate set with no symmetric mac/linux statement

Brief explicitly scopes ship-gate (d) to Win 11 25H2. mac/linux installers exist (chapter 10 §5.2/5.3) but have no equivalent ship-gate. This is the brief's choice — but R4 notes that spec needs to state explicitly: "v0.3 ship requires gate (d) only on Windows; mac/linux installers are tested manually before release; results posted to release notes." Spec currently waves at "mac/linux equivalents written in parallel" (chapter 12 §4.4) without committing to whether they gate.

## Summary

P0: 0 / P1: 2 / P2: 0
Brief is input-only. Findings are about inherited tensions the spec needs to resolve, not against the brief itself.
