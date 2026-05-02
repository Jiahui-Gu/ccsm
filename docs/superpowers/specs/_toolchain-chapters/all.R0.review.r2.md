# R0 re-review (round 2) — toolchain-lock spec

Reviewer: R0 (zero-rework / refactor-fidelity)
Round: 2 (post-fix-round-1, commit `e0e4a74`)
Scope: verify each R0 P0 + P1 from round 1 is actually closed.

## Verdict

**NOT YET clean.** 1 residual R0 P1 (regression of P1-4 within ch04
itself — the canonical decision and the in-chapter summary table now
disagree).

All 3 R0 P0s closed. 4 of 5 R0 P1s closed. R2 + R5 spot-checks pass.

## Per-finding verification

### R0 P0-1 — ch06 PR D file list (regenerate vs create) — CLOSED

`ch06-rollout.md` §v0.2 main rollout PR D (lines 42–90) now uses NEW /
MODIFIED / REGENERATED / DELETED / PRESERVED categories. `pnpm-lock.yaml`
is correctly listed under REGENERATED (line 53), and the
"Lockfile-provenance preflight" block (lines 68–80) gives the explicit
`rm pnpm-lock.yaml package-lock.json && pnpm install && git add
pnpm-lock.yaml` sequence under the pinned toolchain. Synchronization
invariant (lines 63–67) makes the `package-lock.json` deletion explicit.

### R0 P0-2 — node-linker provenance — CLOSED

ch04 §existing `.npmrc` content interaction (line 70) explicitly
declares "This chapter (ch04) is the canonical spec location for the
`node-linker=hoisted` addition." ch03 §workspace configuration (lines
142–144) defers to ch04 as canonical with cross-reference. ch06 PR D
file list (lines 44–46) cites the same: APPENDED to existing `.npmrc`.
No three-way disagreement remains.

### R0 P0-3 — pnpm-lock.yaml provenance — CLOSED

Same preflight block in ch06 (lines 68–80). Requires Node 22 +
Corepack-resolved pnpm 10.33.2 host before pushing PR D; commits the
regenerated lockfile in PR D.

### R0 P1-1 — CI cache-key literal `node20` → `node22` — CLOSED

ch05 §cache key migration note "PR A cache-key sub-fix" subsection
(lines 91–101) covers the stale-ABI cache-hit failure mode and the
literal rename. ch06 PR A file list (line 23) explicitly includes the
cache-key change.

### R0 P1-2 — release-script `command -v` precheck — CLOSED

ch05 §release-candidate verify (lines 173–180) has `command -v node`
and `command -v pnpm` prechecks at the top of the script with
actionable error messages. The pnpm-version extraction (line 190) was
also updated to strip the `+sha512.<hash>` suffix, which is a correct
follow-on.

### R0 P1-3 — Corepack-corporate-proxy footnote — CLOSED

ch03 §onboarding flow (lines 61–74) covers `Cannot find matching
keyid`, `COREPACK_NPM_REGISTRY` (preferred), and
`COREPACK_INTEGRITY_KEYS=0` (last-resort) with cross-ref to
nodejs/corepack#612. ch06 §contributor-environment fallback playbook
step 6 (lines 177–185) duplicates the same content for diagnostic-flow
discoverability. Acceptable duplication (different audiences).

### R0 P1-4 — `engines.pnpm` resolved — PARTIAL (residual P1)

The canonical decision in ch04 §root `package.json#engines` (line 20)
correctly reads `"pnpm": ">=10.33.2 <11"`, and the rationale (lines
33–34) explicitly justifies why `10.x` was rejected:

> `engines.pnpm` is `>=10.33.2 <11` (NOT `10.x`) so the backstop is at
> least as tight as `packageManager`.

However, the **same chapter's** §root vs `packages/*` strategy summary
table (line 124) still reads:

```
| `engines.pnpm` | yes (`10.x`) | NO (root install enforces) |
```

This is exactly the failure mode P1-4 was filed against: "two places
say two different things." A fixer or future reader scanning the
summary table will see `10.x` and may either propagate that into a
sibling spec or "reconcile" by loosening the canonical block back to
`10.x`.

**Severity: P1 (regression of P1-4).** Closing P1-4 in the rationale
block while leaving the table contradictory does not actually close
the finding — the inconsistency the finding warned against still
exists, just one chapter narrower.

**Suggested fix (one-line edit):** in `ch04-engines-strict.md` line
124, change ``yes (`10.x`)`` to ``yes (`>=10.33.2 <11`)``.

### R0 P1-5 — v0.4 daemon binary forward-compat — CLOSED

ch01 §relation to other specs (lines 117–126) adds the v0.4
daemon-binary packaging bullet noting toolchain pin is inherited (no
separate pin), with cross-ref to ch06 §v0.4 forward-compat. ch06 §v0.4
forward-compat: daemon binary packaging (lines 213–225) is the new
section with verification step (`./dist/ccsm_native --version` reports
Node major matching `.nvmrc`). The Connect-Node server's Node 22
compatibility is also explicitly noted (ch01 lines 124–126).

## R2 + R5 spot-checks (less strict, all PASS)

- **R2 P1 #1** — `packageManager` integrity suffix:
  ch03 line 14 has `"pnpm@10.33.2+sha512.<TODO-128-hex-hash>"` plus
  the §decision paragraph (lines 24–41) explaining the threat model
  and the PR D hash-extraction step. PASS.
- **R2 P1 #2** — `--frozen-lockfile` in verification matrices:
  ch03 §verification (lines 204–213) has the explicit `pnpm install
  --frozen-lockfile && git diff --exit-code pnpm-lock.yaml` sequence;
  ch04 §verification (lines 188–193) adds the phantom-dep
  frozen-lockfile drift gate; ch05 §per-row pass criteria (line 237)
  uses the same explicit command sequence. PASS.
- **R5 F1** — done criterion #4 rewritten:
  ch06 §done criteria (lines 203–206) reads "v0.3 monorepo scaffold
  (already on `working` since PR #848 / 81ddaca) is verified
  compatible with the pinned toolchain — i.e. PR D lands on top of
  the existing scaffold without requiring any change to
  `pnpm-workspace.yaml` or `packages/*` skeleton structure." Matches
  the fix-round-1 summary; no longer contradicts ch01/ch06 timing.
  PASS.
- **R5 F2** — PR C grace-period bullet in done criteria #1:
  ch06 §done criteria (lines 197–200) has the new bullet "PR C
  announcement was posted ≥7 days before PR D merged" with explicit
  pinned-issue / discussion-timestamp verification instructions.
  PASS.

## Summary

- R0 P0: 0 outstanding (3/3 closed).
- R0 P1: 1 outstanding (P1-4 partially closed; ch04 §root vs
  `packages/*` strategy summary table still shows `10.x`).
- R2 P1: 0 outstanding (2/2 closed).
- R5 F1/F2: 0 outstanding (2/2 closed).

**Action required before stage-5 merge:** fix the one-line table entry
in `ch04-engines-strict.md` line 124 (``yes (`10.x`)`` →
``yes (`>=10.33.2 <11`)``). After that single edit re-applies, R0
converges fully and the spec is ready for merge.
