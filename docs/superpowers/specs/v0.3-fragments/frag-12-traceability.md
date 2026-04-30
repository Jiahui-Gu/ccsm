# Fragment: §12 traceability matrix to 10-angle reviews

**Owner**: worker dispatched per Task #934
**Target spec section**: new §12 (last section) in main spec
**P0 items addressed**: makes review coverage auditable; no code impact

## What to write here
Replace this section with the actual `## 12. Review traceability` markdown.

A markdown table with columns:
| Review report | MUST-FIX item | Spec v2 section | Status |

One row per MUST-FIX from each of the 10 reports. Status values:
- `addressed in §X.Y` — fully covered in v2
- `addressed in §X.Y (partial)` — spec scopes the fix; full impl in plan
- `deferred to v0.4` — explicit defer with rationale (e.g. sigstore signing)
- `deferred to v0.5` — explicit defer (e.g. Cloudflare Access)
- `out of scope` — review item not accepted; rationale required

**Source reports** (read each for its MUST-FIX list):
- `~/spike-reports/v03-review-resource.md` (GREEN — likely few/no MUST-FIX)
- `~/spike-reports/v03-review-reliability.md`
- `~/spike-reports/v03-review-security.md`
- `~/spike-reports/v03-review-perf.md`
- `~/spike-reports/v03-review-lockin.md` (LOW — likely few)
- `~/spike-reports/v03-review-observability.md`
- `~/spike-reports/v03-review-devx.md`
- `~/spike-reports/v03-review-ux.md`
- `~/spike-reports/v03-review-packaging.md`
- `~/spike-reports/v03-review-fwdcompat.md`

After the table, a short summary paragraph: "N MUST-FIX items addressed in
v2, M deferred to v0.4, K to v0.5, J out of scope. Round-2 review will
verify."

This fragment depends on knowing which §X.Y the other fragments end up
adding. Worker should read the OTHER fragment files in this directory
(not the main spec, since merge hasn't happened) to know section numbers.
If a fragment is empty/stub at time of writing, mark status as "addressed
in §3.4.1 (pending fragment merge)" and let manager fix during merge.

## Plan delta
None — pure doc section. No plan changes.
