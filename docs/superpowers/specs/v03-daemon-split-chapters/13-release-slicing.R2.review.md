# R2 (Security) review — 13-release-slicing

## P2

### P2-13-1 — No phase explicitly owns "security review" or "threat-model sign-off"

§1 phases 0–12 cover function/build/install/test. Security controls are scattered across many phases (auth on phase 2, env scrubbing on phase 4, PTY filter on phase 5, descriptor `boot_id` on phase 2/8, signature verify on phase 10, scrubber on phase 6, etc.). Without a dedicated phase / milestone gating "all security controls implemented and tested", the controls fall through the cracks — every phase reviewer assumes another phase covers it.

Recommend either:
- Add Phase 11.5 (or fold into Phase 12 entry criteria): "Security audit checklist green" — itemise every R2-flagged control and mark each implemented + tested.
- Or add explicit "security acceptance criterion" rows to each phase.

### P2-13-2 — Phase 8 big-bang Electron PR reviewer-load makes security regressions invisible

Cross-ref ch 08 P2-08-3. The release-slicing chapter should explicitly carve security-shaped work out of the phase-8 PR.

### P2-13-3 — Phase 12 dogfood "≥ 7 days of dogfood with no architectural regression PRs" — no security-incident gate

§2 phase 12. If during dogfood a P0 security issue surfaces, the release-slicing rule says architectural change → spec rework, but a security fix (e.g., adding the descriptor `boot_id` field) IS an architectural change that ch 15's zero-rework forbids late. Resolve the tension: either security fixes are exempt from zero-rework (they're "additive bug fixes"), or the spec must be re-cut and the 7-day clock restarts. Pin one.

No P0/P1 findings; chapter is process.
