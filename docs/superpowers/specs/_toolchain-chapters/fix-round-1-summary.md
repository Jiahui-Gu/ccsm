# Fix-round-1 summary — toolchain-lock spec

Closes 3 P0 + 9 P1 from R0/R2/R5 reviews. P2 findings deferred per
spec-pipeline pragmatic gradient (R0/R1/R4 must-fix; R2/R5 pragmatic).

## R0 (zero-rework / refactor-fidelity)

| Finding | Fix location |
|---|---|
| **P0-1** PR D file list desync — `pnpm-lock.yaml` already exists on `working` | `ch06-rollout.md` §v0.2 main rollout PR D — rewrote file list (NEW / MODIFIED / REGENERATED / DELETED / PRESERVED), added explicit "delete `pnpm-lock.yaml` + `package-lock.json` then `pnpm install` under pinned toolchain" preflight, added synchronization invariant sentence. |
| **P0-2** `node-linker=hoisted` provenance disagreement across ch03/ch04/ch06 | `ch04-engines-strict.md` §existing `.npmrc` content interaction — declared canonical "this is added in PR D" location; `ch03-pnpm-pinning.md` §workspace configuration — split "already on `working` (PR #848)" vs "added by this spec (PR D)" lists, cross-references ch04 for mechanism, added critical-sequencing note; `ch06-rollout.md` PR D file list explicitly cites `node-linker=hoisted` is APPENDED to existing `.npmrc`. |
| **P0-3** `pnpm-lock.yaml` provenance unverified | `ch06-rollout.md` §v0.2 main rollout PR D — added "Lockfile-provenance preflight" block with exact `rm` + `pnpm install` + `git add` sequence, requires running on Node 22 + Corepack-resolved pnpm 10.33.2 host before pushing PR D. |
| **P1-1** CI cache-key literal `node20` not bumped in PR A | `ch05-ci-and-onboarding.md` §cache key migration note — added "PR A cache-key sub-fix" subsection explaining the stale-ABI cache-hit failure mode and the literal rename to `node22` (or `${{ steps.setup.outputs.node-version }}`); `ch06-rollout.md` PR A file list now explicitly includes the cache-key change. |
| **P1-2** release-candidate verify lacks `command -v` precheck for Windows Git Bash | `ch05-ci-and-onboarding.md` §release-candidate verify — added `command -v node` and `command -v pnpm` prechecks at top of script; also updated pnpm-version extraction to strip the new `+sha512.<hash>` suffix. |
| **P1-3** Corepack signature behind corporate proxy not addressed | `ch03-pnpm-pinning.md` §onboarding flow — added footnote covering `Cannot find matching keyid` error, `COREPACK_NPM_REGISTRY` (preferred) and `COREPACK_INTEGRITY_KEYS=0` (last-resort) workarounds; `ch06-rollout.md` §contributor-environment fallback playbook — added step 6 with same content. |
| **P1-4** `engines.pnpm: "10.x"` looser than `packageManager` exact pin | `ch04-engines-strict.md` §root `package.json#engines` — tightened `engines.pnpm` to `">=10.33.2 <11"`; rewrote rationale to explain backstop must be at least as tight as `packageManager`. |
| **P1-5** v0.4 daemon binary packaging forward-compat blind spot | `ch01-overview.md` §relation to other specs — added v0.4 daemon-binary packaging bullet explaining the toolchain pin is inherited (no separate pin); `ch06-rollout.md` — added new §v0.4 forward-compat: daemon binary packaging section. |

## R2 (supply-chain security)

| Finding | Fix location |
|---|---|
| **P1 #1** `packageManager` lacks `+sha512.<hash>` integrity suffix | `ch03-pnpm-pinning.md` §decision — changed `packageManager` to `"pnpm@10.33.2+sha512.<TODO-128-hex-hash>"`, added paragraph explaining the registry-republish threat model and the PR D hash-extraction step. |
| **P1 #2** `--frozen-lockfile` not in verification matrices | `ch03-pnpm-pinning.md` §verification — replaced "exits 0 with no lockfile modification" with explicit `pnpm install --frozen-lockfile && git diff --exit-code pnpm-lock.yaml` sequence; `ch04-engines-strict.md` §verification — added fourth bullet with phantom-dep frozen-lockfile drift gate; `ch05-ci-and-onboarding.md` §per-row pass criteria — replaced soft "no lockfile diff" with explicit command sequence. |

## R5 (consistency / clarity)

| Finding | Fix location |
|---|---|
| **F1 (P1)** Done criterion #4 contradicts ch01/ch06 about scaffold timing | `ch06-rollout.md` §done criteria — rewrote bullet #4 from "lands on top of the locked toolchain" to "v0.3 monorepo scaffold (already on `working` since PR #848 / 81ddaca) is verified compatible with the pinned toolchain". |
| **F2 (P1)** Done criteria #1 omits PR C grace-period verification | `ch06-rollout.md` §done criteria — added new bullet between #1 and CI-green: "PR C announcement was posted ≥7 days before PR D merged" with explicit instructions to verify by checking pinned-issue / discussion timestamp against PR D merge timestamp. |

## Files touched

- `docs/superpowers/specs/_toolchain-chapters/ch01-overview.md`
- `docs/superpowers/specs/_toolchain-chapters/ch03-pnpm-pinning.md`
- `docs/superpowers/specs/_toolchain-chapters/ch04-engines-strict.md`
- `docs/superpowers/specs/_toolchain-chapters/ch05-ci-and-onboarding.md`
- `docs/superpowers/specs/_toolchain-chapters/ch06-rollout.md`

(ch02 unchanged — no R0/R2/R5 P0/P1 findings landed in ch02.)

## Out of scope (deferred)

- All R0/R2/R5 P2 findings (cosmetic / nice-to-have per spec-pipeline
  gradient).
- F5 (`.npmrc` comment file path) — cosmetic, will be resolved when
  chapters are merged into a single design doc.
- F7 (nested fenced code blocks in ch05 onboarding) — cosmetic markdown
  rendering edge case.
- ch02 §file contents threat-model paragraph (R2 P2 #3) — documentation
  nicety, no risk.
