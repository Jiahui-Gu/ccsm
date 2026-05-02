# v0.3 design v2 fragments

Temporary working files for parallel drafting of design v2 sections.

**Lifecycle (updated 2026-05-01, Task #1043)**: each `frag-*.md` was originally
drafted by a dedicated worker for parallel review. They were then concatenated
into `docs/superpowers/specs/v0.3-design.md`. The original plan was to delete
this directory after merge — that plan is reversed: the fragments are retained
as the **canonical** spec and `v0.3-design.md` is now a thin index pointing
into them (drift between the two copies during r10–r12 review forced the flip;
see PR #757 / #758 for the perMachine reconciliation that exposed the drift).

All future spec edits land in the fragment file only. Do not re-embed fragments
into `v0.3-design.md`.

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

**Spec v1 baseline**: `docs/superpowers/specs/v0.3-design.md` (the surviving v0.3 index — see that file for pointers into the canonical fragments).

**Plan v1 baseline**: `docs/superpowers/plans/2026-04-30-v0.3-daemon-split.md`

---

## Anti-regression lint: dataRoot single source

**DO NOT** introduce `%APPDATA%\ccsm` or `~/.config/ccsm/` paths anywhere
in `v0.3-fragments/`. The canonical v0.3 dataRoot is owned by **frag-11
§11.6** as the single source:

- Windows: `%LOCALAPPDATA%\ccsm\`
- macOS:   `~/Library/Application Support/ccsm/`
- Linux:   `~/.local/share/ccsm/`

Every other fragment (frag-3.7, frag-6-7, frag-8, frag-12) MUST cross-ref
frag-11 §11.6 rather than inlining its own path table. Drift between
fragment copies of the dataRoot list is the exact bug Audit 2 F7 / Audit
1 F8 (Task #63) called out.

**Exception**: frag-8 §8.1 may reference legacy v0.2 paths
(`%APPDATA%\CCSM\` with capital `CCSM`, `~/.config/CCSM/`) **only in
migration-source context** — those are v0.2's Electron product-name
paths that the v0.2 → v0.3 migration reads from, not v0.3 dataRoot
candidates. The capital-`CCSM` casing distinguishes them from the
forbidden lowercase `ccsm` paths.

---

## Anti-regression lint: crash schema source of truth

The crash artifact directory layout and meta.json schema are owned by
`docs/superpowers/specs/2026-05-01-crash-observability-design.md` (per-incident
dir under `<dataRoot>/crashes/<YYYY-MM-DD-HHMM>-<incidentId>/` with
`meta.json` + `frontend.*` + `backend.*` + `daemon-marker.json` +
`stderr-tail.txt` + `stdout-tail.txt` + optional `screenshot.png`).
**DO NOT** re-introduce the older single-file schema
`crash-<isoTs>-<bootNonce>.json` with `{ side, v, pid, boot, errMessage,
errStack, lastTraceIds, lastSessions, stats, ts }` — it is superseded
(see frag-6-7 §6.6.3 for the supersession rationale).

