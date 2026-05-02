# R3 review — 13-release-slicing

## P2-R3-13-01 — Phase 6 (crash collector) does not include logging / metrics

If R3-09-01 (logging) and R3-09-02 (metrics) are accepted, Phase 6 acceptance criteria need updating to include: "structured logger initialized at boot, before any subsystem; per-OS log destinations created with correct ACL; `/metrics` endpoint exposed on Supervisor UDS." Otherwise the implementer treats logging as an afterthought and bolts it on after dogfood, which is the worst time.

Cross-reference R3-09-01 / R3-09-02. Once those land, this becomes a P1.

## P2-R3-13-02 — Phase 11 ship-gate harness scope

Phase 11 lists ship-gates (a)/(b)/(c)/(d). If R3-12-02 negative-path soak variants are added, Phase 11(c) acceptance grows. Adjust DAG accordingly when fixing R3-12-02.

NO FINDING beyond the cross-references.
