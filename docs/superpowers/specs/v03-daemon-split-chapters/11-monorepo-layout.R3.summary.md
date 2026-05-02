# R3 review — 11-monorepo-layout

No reliability/observability findings. Chapter is structural.

One cross-cutting observation (NOT a finding):

If the logging spec (per R3-09-01) is added, it should land as a thin shared package — e.g., `packages/logger` — consumed by both `@ccsm/daemon` and `@ccsm/electron` so the format is identical across processes and `requestId` correlation works end-to-end. The current §3 dep graph (proto only) would gain a second leaf. Coordinate when fixing R3-09-01.

NO FINDING.
