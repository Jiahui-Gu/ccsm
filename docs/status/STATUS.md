# Implementation Status

This file no longer tracks a per-feature reconciliation table — the project
moved past the MVP-checklist phase and the table fell ~1380 PRs behind the
code before being retired.

For current state, use:

- **`git log`** — authoritative shipping history (PRs land directly on `main`).
- **`DEBT.md`** at repo root — known open debt, prioritised, with `file:line`
  citations refreshed by audit.
- **GitHub Releases** — version-tagged checkpoints (`vX.Y.Z`).

`docs/mvp-design.md` remains the frozen design intent. When current behavior
diverges from it, the divergence is intentional (see `git log` for the PR
that made the call).
