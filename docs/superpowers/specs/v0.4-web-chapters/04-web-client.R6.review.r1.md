# Review of chapter 04: Web client

Reviewer: R6 (Naming / consistency / clarity)
Round: 1

## Findings

### P2-1 (nice-to-have): Untagged code fences for workspace tree

**Where**: §1 line 20 (open) and line 50 (close) — workspace tree block has bare ``` open. Same problem in §3 line 72 (`ts` — correctly tagged), §4 line 126 (`yaml` — tagged). So §1 alone is untagged.
**Issue**: Inconsistent with sibling tagged blocks; renders without highlighting (fine for trees, but consistency matters).
**Suggested fix**: ```` ```text ```` for the tree block. Bundle into the cross-chapter untagged-fence fixer flagged in 02 P2-1 and 05 P1-1.

### P2-2 (nice-to-have): Pages URL placeholder churn

**Where**:
- 04 §4 line 133: "preview URL `https://<sha>.ccsm-app.pages.dev`"
- 05 §2 line 62: "Pages assigns `<project>.pages.dev` (e.g. `ccsm-app.pages.dev`)"
- 09 §5 line 123: "or `<deploy>.pages.dev`"

**Issue**: three placeholder forms (`<sha>`, `<project>`, `<deploy>`) for what is essentially the same Pages domain pattern. Reader can't tell whether they refer to different Pages projects or the same one with different placeholder choices.
**Why P2**: doesn't block implementation; readability.
**Suggested fix**: settle on `<project>.pages.dev` for the production project name; use `<sha>.<project>.pages.dev` (Cloudflare's actual preview URL format is `<branch-or-commit>.<project-name>.pages.dev`) for previews. Bundle with the 00 P2-2 placeholder normalization fixer.

### P2-3 (nice-to-have): "VITE_TARGET" / "VITE_PLATFORM" env-var convention not stated up front

**Where**: §3 line 86-87 introduces `VITE_TARGET` and `VITE_PLATFORM` as build-time defines. §2 line 60 mentions `VITE_PLATFORM`. Chapter 03 §2 line 50 references `VITE_TARGET === 'web'`. No central convention stating these env-vars are the canonical client-target switches.
**Issue**: An implementer adding a third client (mobile? CLI?) won't know whether to invent a new VITE_ prefix or follow existing convention.
**Suggested fix**: in 04 §3 add a sentence: "Convention: `VITE_*` env vars hold build-time client-target switches. `VITE_TARGET ∈ {electron, web}`; `VITE_PLATFORM ∈ {win32, darwin, linux, web}`. Add new vars under the `VITE_` prefix to keep build-config discoverable."

## Cross-file findings (if any)

- P2-1 (untagged fences) bundles with 02 P2-1 and 05 P1-1.
- P2-2 (Pages placeholder) bundles with 00 P2-2 (placeholder normalization fixer).
