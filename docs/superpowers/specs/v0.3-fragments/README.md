# v0.3 design v2 fragments

Temporary working files for parallel drafting of design v2 sections.

**Lifecycle**: each `frag-*.md` is written by a dedicated worker, then merged
into `docs/superpowers/specs/2026-04-30-web-remote-design.md` by the manager
in pool-2. After merge, this entire directory is deleted in the merge commit.

**Why fragments**: 7 sections drafted in parallel against a single spec file
would rebase-storm. Fragments are independent files, zero conflicts.

**Plan changes**: each fragment ends with a `## Plan delta` section describing
how `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md` should be patched
(which Task N gains/loses what hours, new tasks, etc.). Manager applies all
deltas to plan in the merge commit.

**Source review reports** (read these before drafting your fragment):
- `~/spike-reports/v03-review-resource.md` (GREEN)
- `~/spike-reports/v03-review-reliability.md` (YELLOW)
- `~/spike-reports/v03-review-security.md` (YELLOW)
- `~/spike-reports/v03-review-perf.md` (YELLOW)
- `~/spike-reports/v03-review-lockin.md` (LOW)
- `~/spike-reports/v03-review-observability.md` (YELLOW)
- `~/spike-reports/v03-review-devx.md` (YELLOW)
- `~/spike-reports/v03-review-ux.md` (YELLOW, critical: SQLite migration)
- `~/spike-reports/v03-review-packaging.md` (YELLOW)
- `~/spike-reports/v03-review-fwdcompat.md` (YELLOW)

**Spec v1 baseline**: `docs/superpowers/specs/2026-04-30-web-remote-design.md`
(read this entire file once; v2 is additive — keep v1 wording where unchanged).

**Plan v1 baseline**: `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`
