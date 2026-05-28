---
name: doc-audit
description: Audit project documentation against current code to find drift. Use when docs have fallen significantly behind code and you need a triage list before rewriting. Produces DOC_AUDIT.md with per-file verdicts (OK / minor / rewrite / delete). Does NOT auto-rewrite — user decides.
---

# Doc Audit

One-shot audit of `ccsm` project docs against current code. Produces a triage list, not edits.

## Scope

**Audit these (the live, code-derived docs):**

- `README.md`
- `docs/reference/*.md` — all files
- `docs/superpowers/plans/*.md` — all files
- `docs/status/STATUS.md`
- `docs/attach-redesign.html`
- `DEBT.md`

**Skip these (frozen, archived, or time-stamped snapshots — do NOT touch):**

- `docs/mvp-design.md` (marked frozen in `docs/README.md`)
- `docs/design-system.md` (marked locked)
- `docs/archive/**`
- `docs/dogfood/**`
- `docs/eval/**`
- `docs/status/post-migration-gap-triage-*.md` (dated snapshot)
- `docs/reference/ui-ux-pro-max-audit-*.md` (dated snapshot)
- `RELEASE_NOTES_v*.md`
- `CONTRIBUTING.md`, `SECURITY.md`, `LICENSE`
- Anything under `node_modules/`, `dist/`, `build/`

If a doc filename contains a date (`YYYY-MM-DD`) or lives under `archive/`, `dogfood/`, `eval/` — it's a snapshot, skip it.

## Method

For each in-scope doc:

1. **Read the doc fully.**
2. **Extract concrete claims** that can be checked against code:
   - Named files/paths (`src/foo/bar.ts`)
   - Function/class/symbol names
   - CLI flags, config keys, env vars
   - Described behaviors / flows / invariants
   - Architecture diagrams referencing real modules
3. **Verify each claim against current code** — Grep/Glob/Read the named symbols and paths.
4. **Assign one verdict** (and only one):

   | Verdict | Meaning |
   |---|---|
   | **OK** | Claims match code. No action. |
   | **MINOR** | A few outdated names/paths/flags but structure is right. Surgical edits. |
   | **REWRITE** | Section structure or core narrative no longer reflects code. Needs section-level rewrite. |
   | **DELETE** | Document describes a feature/flow that no longer exists. Propose deletion. |

5. **Cite specific evidence** for the verdict — at least one concrete drift point per non-OK doc, with `file:line` for both doc and code where relevant.

## Output

Write `DOC_AUDIT.md` at repo root with this structure:

```markdown
# Doc Audit — <YYYY-MM-DD>

## Summary
- OK: N
- MINOR: N
- REWRITE: N
- DELETE: N

## Findings

### <doc/path.md> — <VERDICT>

**Drift points:**
- Claims `src/foo.ts:fooBar()` exists — actually moved to `src/bar.ts:barFoo()` at commit abc1234
- References `--legacy-mode` flag — removed in #1234

**Suggested action:** <one line>

---

(repeat per doc)
```

## Rules

- **Do not edit any doc** during audit. Output is the audit file only.
- **Do not fabricate** drift points — if you can't verify a claim, mark it "unverified" and move on; don't guess.
- **Be specific.** "Outdated" is not a finding. "Mentions `warmRegistry` which was deleted in #1403" is a finding.
- **One doc, one verdict.** Don't hedge with "MINOR-to-REWRITE" — pick the higher.
- **Sort findings** in output: REWRITE → DELETE → MINOR → OK.
- When done, print a one-line summary to the user: "Audit done. N rewrites, N minor. See DOC_AUDIT.md."
