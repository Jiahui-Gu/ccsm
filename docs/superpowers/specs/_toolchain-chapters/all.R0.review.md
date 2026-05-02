# Review of toolchain-lock spec — all chapters

Reviewer: R0 (zero-rework / refactor-fidelity)
Round: 1
Scope: ch01 through ch06

## Methodology

The R0 angle asks: does the spec introduce work that v0.4 (or even v0.3
ship-gate) will throw away? "Zero-rework" per
`feedback_v03_zero_rework.md`: every line written must still be in use
post-v0.4. Special focus on:

1. v0.3 monorepo (PR #848) treated as DONE, not redone.
2. PR A/B/C/D sequence (ch06 §v0.2 main rollout) compatible with the
   `working` branch as it stands today.
3. No "v0.4 will add this" placeholders — only hard locks now.
4. Volta footnote keeps `package.json#volta` out — confirms no future churn.
5. CI changes forward-compatible with v0.4 daemon-split (Connect-RPC
   over loopback HTTP/2; binary signing; cloudflared sidecar).

I verified the current `working` branch state before reading the spec:

- `package.json` has `"packageManager": "pnpm@10.33.2"` (PR #848). YES.
- `pnpm-workspace.yaml` + `packages/{daemon,electron,proto}` present. YES.
- `pnpm-lock.yaml` present (~395 KB). YES.
- `package-lock.json` STILL PRESENT alongside `pnpm-lock.yaml`. (See P0-1.)
- `.npmrc` contains ONLY `clang=0` — no `engine-strict`, no `node-linker`.
- No `.nvmrc` file.
- `.github/workflows/ci.yml` still pins `node-version: '20'` and uses
  `npm ci --legacy-peer-deps` against `package-lock.json`.
- `package.json#scripts` (`build`, `test`, `typecheck`, `lint`) still call
  `npm run`/`tsc`/`vitest`/`eslint` directly (no `pnpm` invocation
  needed since they don't shell out to a package manager).
- Root `package.json` has NO `engines` field today.

So the v0.3 scaffold is "born pnpm" only at the file-layout level; the
actual installer remains npm. The spec is correct that PR D must do the
atomic flip.

## Findings

### P0-1 (BLOCKER): ch06 PR D atomic-flip is too large given the v0.3 scaffold already on `working`

**Where**: ch06 §v0.2 main rollout, PR D bullet (lines ~41–58).

**Issue**: PR D is described as a single atomic change that does ALL of:

- add `engines` field to root + every `packages/*/package.json`,
- add `engine-strict=true` + `node-linker=hoisted` to root `.npmrc`,
- flip every `package.json#scripts` from `npm` to `pnpm`,
- DELETE `package-lock.json`,
- replace `npm ci --legacy-peer-deps` with `pnpm install --frozen-lockfile`
  in EVERY workflow (ci.yml, e2e.yml, release.yml),
- add the release-candidate verify block.

But the v0.3 scaffold has ALREADY landed `pnpm-workspace.yaml`,
`packages/*`, `pnpm-lock.yaml`, AND `packageManager: pnpm@10.33.2` on
`working` (PR #848). The chapter still describes PR D as creating
`pnpm-lock.yaml` ("`pnpm-lock.yaml` (new, replaces `package-lock.json`)").
That is no longer true: the lockfile already exists.

**Why this is P0**:

1. A reader (or fixer) following the spec literally would either (a)
   regenerate `pnpm-lock.yaml`, producing a noisy diff against the
   existing 395 KB file with no semantic change — pure rework — OR (b)
   skip "create pnpm-lock.yaml" and silently desync the spec from
   reality.
2. Worse, the spec hides the actual ship-blocker: today, BOTH lockfiles
   coexist on `working`. Anyone who runs `npm ci` (current CI does)
   gets npm-resolved deps; anyone who runs `pnpm install` gets
   pnpm-resolved deps. These are not guaranteed to agree. The spec
   does not call out "delete package-lock.json the moment we flip CI"
   as a synchronization requirement, even though that synchronization
   is the entire reason PR D exists.
3. Per zero-rework rule: any work the spec asks for that a future PR
   re-does is forbidden. Re-creating `pnpm-lock.yaml` IS rework.

**Suggested fix**: Rewrite ch06 §v0.2 main rollout PR D file list to
reflect actual `working` state:

- Files NEWLY created: `engines` field added to root + per-package
  `package.json`, `engine-strict=true` + `node-linker=hoisted` appended
  to existing `.npmrc`, release-candidate verify block in
  `scripts/release-candidate.sh`.
- Files MODIFIED: `package.json#scripts` (only the lines that shell out
  to a package manager — most `tsc`/`vitest`/`eslint` calls don't need
  changes), all three workflow files.
- Files DELETED: `package-lock.json` (the existing one).
- Files PRESERVED AS-IS: `pnpm-lock.yaml` (already correct from PR #848
  toolchain), `pnpm-workspace.yaml`, `packages/*` skeletons.

Add an explicit "synchronization invariant" sentence: "The moment CI
flips to `pnpm install --frozen-lockfile`, `package-lock.json` MUST be
removed in the same commit; otherwise `npm ci` continues to work
locally and silently diverges from CI."

---

### P0-2 (BLOCKER): ch04 §root .npmrc shows `node-linker=hoisted` as if newly added, but ch03 says it's already there — and on `working` it is NOT there

**Where**: ch04 §root .npmrc final-file block (lines 64-78); ch03
§workspace configuration (lines 100-112).

**Issue**: Two-way contradiction with reality:

- ch03 §workspace configuration: "`pnpm-workspace.yaml` is already in
  place at root (landed alongside daemon-split spec ch11 monorepo
  scaffold)" and then says "the relevant pnpm setting on top of this
  workspace file is `node-linker`. In root `.npmrc`: `node-linker=hoisted`"
  — phrased as if `node-linker=hoisted` is also already there.
- ch04 §root .npmrc shows the "final file" with `node-linker=hoisted`
  appended, implying THIS spec adds it.
- ch06 §v0.3 packages/* rollout lists `node-linker=hoisted` as MISSING.
- Reality on `working` (verified): `.npmrc` contains only `clang=0`.
  Neither `engine-strict` nor `node-linker` is present.

So ch03 quietly assumes `node-linker=hoisted` is already done; ch04
adds it; ch06 lists it as missing. Three chapters disagree.

**Why this is P0**: A fixer assigned to ch03 will not add
`node-linker=hoisted` (since ch03 reads as descriptive, not
prescriptive). A fixer assigned to ch04 will add it. A fixer assigned
to ch06 PR D file list will add it. Result: either duplicate addition
(merge conflict) or — worse — if PR D is the only mover, ch03's
"already in place" claim is wrong AND if the v0.3 scaffold ships
without `node-linker=hoisted`, Electron-builder breaks on Windows
(per ch03's own warning). This is a v0.3 ship-gate failure mode that
a casual reading of ch03 would mask.

**Suggested fix**:

1. ch03 §workspace configuration: split into "what landed in PR #848"
   (i.e. `pnpm-workspace.yaml`, `packages/*`, `pnpm-lock.yaml`,
   `packageManager` field) vs "what THIS spec adds on top"
   (`node-linker=hoisted`, `engine-strict`, `engines`, `.nvmrc`).
2. Make explicit that `node-linker=hoisted` MUST land BEFORE any
   `packages/electron` build is attempted, otherwise Windows ASAR
   packing breaks. Currently the urgency is implicit.
3. Cross-reference ch06 PR D so the file list there matches.

---

### P0-3 (BLOCKER): Spec does not address `pnpm-lock.yaml` provenance — risk of v0.3 lockfile being silently regenerated and breaking native ABI alignment

**Where**: ch03 (no mention); ch06 §v0.2 main rollout PR D.

**Issue**: The current `pnpm-lock.yaml` on `working` was produced by
PR #848 — but on which OS, which Node, which pnpm? If PR D is run by a
release manager whose local `pnpm` differs even by patch from
`packageManager: pnpm@10.33.2`, or whose Node is not 22.x, the lockfile
gets regenerated with subtle differences. Native dep optional sections
(`better-sqlite3`'s `prebuilds`, `node-pty`'s post-install) are
particularly sensitive — and these are the exact deps ch01 cites as
the recurring drift bug.

The spec assumes "lockfile is already correct" but provides no
verification step that the existing lockfile was produced by the
pinned tools. If it wasn't, the very first `pnpm install
--frozen-lockfile` on a contributor laptop fails with a checksum
mismatch.

**Why this is P0**: The whole point of this spec is to eliminate
"works on my machine" via toolchain pinning. Shipping a lockfile that
was generated OFF the pinned toolchain immediately re-introduces the
exact bug class. Per zero-rework: a follow-up PR to "regenerate
lockfile under pinned toolchain" IS rework that the v0.3 spec must
prevent now.

**Suggested fix**: Add to ch05 §reverse-verify matrix or ch06 PR D a
preflight requirement: "Before merging PR D, the release manager runs
`rm pnpm-lock.yaml && pnpm install` on a host where `node --version`
matches `.nvmrc` and `pnpm --version` matches `packageManager`, and
commits the regenerated lockfile in PR D. This guarantees the
shipped lockfile is provenance-pinned to the pinned toolchain."
Optionally add a CI check: a `lockfile-provenance` job that fails if
`pnpm install --frozen-lockfile` mutates the file.

---

### P1-1 (must-fix): CI Node 22 bump in PR A breaks the `working` branch's existing npm cache key without a migration note

**Where**: ch05 §cache key migration note (lines 85-89); ch06 PR A
(lines 20-30).

**Issue**: ch06 PR A bumps CI to Node 22 but stays on `npm ci` (the
chapter says "Engine-strict NOT yet on" and PR A is just `.nvmrc` +
workflow node-version bump). The current cache key on `working` is
`nm-${{ runner.os }}-${{ runner.arch }}-node20-${{ hashFiles('package-lock.json') }}`
— it embeds `node20`. If PR A bumps to Node 22 but keeps the cache
step unchanged, the literal string `node20` in the key remains, so
all PR A builds get a cache hit on a `node_modules/` that was rebuilt
against Node 20 ABI. Native modules (`better-sqlite3`, `node-pty`)
will load against Node 22 → `NODE_MODULE_VERSION` mismatch → CI fails
mysteriously on the very PR that's supposed to be "low-risk".

**Why P1**: Not a blocker because the symptom is a CI failure, not a
silent ship; it gets caught in the PR check. But it forces an
unplanned PR A fix-up cycle (rework) and undermines the "PR A is
trivial" framing.

**Suggested fix**: ch06 PR A file list must also include the cache
key change in the existing `Cache node_modules` step: rename the
`node20` literal to `node22` (or to `${{ steps.setup.outputs.node-version }}`
to make it self-updating). Add a sentence: "PR A also touches the
node_modules cache key to avoid a stale-ABI cache hit; this is part
of the same low-risk PR because it's the same Node-version concern."

---

### P1-2 (must-fix): release-candidate verify uses bash array slicing that fails on Windows Git Bash on a freshly-cloned checkout

**Where**: ch05 §release-candidate verify (lines 152-173).

**Issue**: The script uses `node -p "require('./package.json').packageManager.split('@')[1]"`
to extract the pnpm version. On Windows Git Bash with a system Node
that pre-dates PR D (i.e. before contributors run `corepack enable`),
this evaluation runs against whatever Node is on PATH. Two failure
modes:

1. If the host has no Node at all (clean Windows), `node` is not
   found, the script errors before printing the diagnostic message.
2. If the host has system Node but no Corepack-prepared pnpm, then
   `pnpm --version` (line 169) errors before the comparison runs.

Either failure aborts the release with a non-actionable error
("`node: command not found`") rather than the intended diagnostic
("FATAL: release host runs Node X, .nvmrc says Y").

**Why P1**: The spec explicitly says (lines 175-180) "belt and
suspenders is justified for release". A safety belt that fails closed
with a confusing error on the most-common Windows release host
defeats the purpose. Also per zero-rework: a follow-up PR to harden
this script IS rework.

**Suggested fix**: Wrap in a precheck:

```bash
command -v node >/dev/null 2>&1 || {
  echo "FATAL: 'node' not on PATH. Install via fnm/nvm and run 'nvm use'."
  exit 1
}
command -v pnpm >/dev/null 2>&1 || {
  echo "FATAL: 'pnpm' not on PATH. Run 'corepack enable'."
  exit 1
}
```

Add this to the script template in ch05.

---

### P1-3 (must-fix): No mention of how `corepack enable` interacts with Node 22's `signature verification` default

**Where**: ch03 §onboarding flow; ch05 §onboarding.

**Issue**: Node 22 ships Corepack 0.31, which ENFORCES signature
verification of downloaded package-manager binaries by default. If
the contributor's network blocks `https://registry.npmjs.org` (common
on corporate firewalls / behind proxy), `corepack enable` succeeds
silently but `pnpm install` (which triggers Corepack to download
pnpm@10.33.2 lazily) fails with `Error: Cannot find matching keyid`.
The error message is not Google-able to a clear fix.

This concretely affects the v0.3 ship: CCSM has Microsoft
contributors (per the user's own environment) where corporate proxies
are common.

**Why P1**: Ship-blocker for a non-trivial slice of the contributor
base, but workaround exists (`COREPACK_INTEGRITY_KEYS=0` env). The
spec's onboarding doc must mention it; otherwise every affected
contributor files an issue → support burden → an "onboarding doc
fix" PR → rework.

**Suggested fix**: Add to ch06 §contributor-environment fallback
playbook a step 6: "Corepack signature error behind corporate proxy:
set `COREPACK_INTEGRITY_KEYS=0` in your shell profile and re-run
`corepack enable`. (See Node issue nodejs/corepack#612.)"

---

### P1-4 (must-fix): `engines.pnpm: "10.x"` allows pnpm 10.0.0 through 10.99 but `packageManager: pnpm@10.33.2` is exact — engine-strict will not catch a Corepack bypass to 10.0.0

**Where**: ch04 §root package.json#engines (lines 16-23).

**Issue**: The two pnpm pins disagree in scope:

- `packageManager: pnpm@10.33.2` — exact, enforced by Corepack.
- `engines.pnpm: "10.x"` — range, enforced by `engine-strict=true`.

If a contributor sets `COREPACK_ENABLE_STRICT=0` (which the spec
itself uses in its own verification example, ch04 line 173) and
manually runs `pnpm@10.0.0 install`, engine-strict accepts it
(`10.0.0` matches `10.x`). The lockfile gets resolved by an old pnpm
that may compute different peer deps or different optional-dep
selections than 10.33.2.

The spec acknowledges in ch03 (line 19) that exact pinning is needed
to prevent two-tier drift, but ch04's `engines.pnpm: "10.x"` makes
the engine-strict backstop weaker than the primary lock.

**Why P1**: Belt-and-suspenders inversion: the suspenders (engines)
are loose while the belt (Corepack) is tight. The spec's claimed
"backstop" role for engines is half-functional.

**Suggested fix**: Either:

- Tighten `engines.pnpm` to match `packageManager` exactly
  (`engines.pnpm: "10.33.2"`), and add to ch06 PR D that BOTH lines
  bump together when bumping pnpm patch (single coordinated change),
  OR
- Drop `engines.pnpm` entirely (keep only `engines.node`) and
  document that pnpm is enforced solely by Corepack + `packageManager`
  field. Removing the half-functional backstop is honest.

Recommendation: drop `engines.pnpm`. Reason: Renovate (deferred to
v0.4) can already keep `packageManager` and `engines.pnpm` in sync if
both exist, but the simpler design is "one place per concern." ch01
itself emphasizes "the recurrent drift bug is two places say two
different things" (ch02 line 11) — applying that principle here means
removing `engines.pnpm`.

---

### P1-5 (must-fix): Spec does not state how the toolchain lock interacts with v0.4 daemon binary signing / packaging (a forward-compat blind spot)

**Where**: ch01 §forever-stable shape (lines 84-97); ch01 §relation
to other specs (lines 99-116).

**Issue**: v0.3 ship goal explicitly includes "daemon signing,
0-byte+after-pack, Sentry symbols, installer size" (per
`project_v03_ship_goal.md`). v0.4 layers Connect-RPC + cloudflared
sidecar binaries. None of these are pure-Node — they involve native
binaries built against a specific Node ABI.

The spec mentions `better-sqlite3` and `node-pty` rebuild but says
nothing about:

1. The Connect-Node server (`@connectrpc/connect-node`) — pure JS, no
   issue, but worth confirming it's compatible with Node 22 (it is,
   but the spec should note it as part of "v0.4 forward-compat
   verified").
2. `electron` itself — current v0.2 uses Electron 28; the spec
   asserts (ch01 line 65-66) that Node 22 "matches what Electron 33+
   ships internally." This needs verification: if v0.2 is on Electron
   28 (Node 18 internal) and CI is bumped to Node 22, the host-Node /
   Electron-Node mismatch may matter for native rebuilds.
3. The daemon binary build (`pkg`/`@yao-pkg/pkg` or whatever v0.3
   uses to produce a single `ccsm_native` binary) needs to embed
   Node 22 — if the bundler is pinned to a different Node, the
   shipped daemon binary's ABI doesn't match the lockfile's native
   builds.

**Why P1**: Not a blocker for the spec's text but a blind spot that
will surface as rework when v0.3 daemon-split lands. The whole spec
is "the toolchain lock for v0.2/v0.3/v0.4" — it must mention the
daemon-binary case at least to defer it.

**Suggested fix**: Add a §daemon binary forward-compat subsection to
ch01 or ch04: "The `@ccsm/daemon` package (v0.3+) will be packaged as
a single binary via [pkg tool TBD]. The packager MUST embed a Node
that matches `.nvmrc` major. If the packager is itself version-pinned
(e.g. `@yao-pkg/pkg`'s embedded Node), bump it whenever `.nvmrc`
bumps. Verification step: `./dist/ccsm_native --version` reports
Node major matching `.nvmrc`." Cross-reference daemon-split spec.

Also verify Electron 28 → Node 22 host compatibility: cite the
specific Electron-version-bump PR (if planned) or add a P1 note in
ch06 §v0.2 main rollout that "PR A's Node 22 jump assumes Electron
33+ is already on `working`; if not, sequence the Electron bump
first." (As of `working` HEAD, Electron version is unconfirmed by
this review.)

---

### P2-1 (nice-to-have): ch01 §relation to other specs cites "PR #848" but should also cite "PR #848 has merged" with the actual SHA

**Where**: ch01 lines 109-113.

**Issue**: The spec says "(already merged or in-flight at time of
writing)". As of this review, PR #848 IS merged (commit `81ddaca`
"Merge pull request #848 from Jiahui-Gu/dev/t0.1-monorepo-skeleton").
The hedging language is now stale.

**Why P2**: Cosmetic; spec readers a month from now will lose context.

**Suggested fix**: Replace with "PR #848 (merged 2026-05-03 as
`81ddaca`)".

---

### P2-2 (nice-to-have): ch06 §done criteria condition 5 ("zero open issues mentioning 'ERR_PNPM_UNSUPPORTED_ENGINE' in past 7 days") is unmeasurable on a private repo with low issue volume

**Where**: ch06 §done criteria (lines 152-164).

**Issue**: CCSM today has very few external contributors filing
issues. A "zero issues in 7 days" criterion can be trivially met by
nobody filing any issues at all — it doesn't actually evidence
contributor absorption.

**Why P2**: Doesn't block ship; just a vague metric.

**Suggested fix**: Replace with a positive signal: "Three
maintainers have run the reverse-verify matrix on their own machine
within 7 days of PR D merge (logged in the PR D thread)." Or drop
condition 5 entirely if conditions 1-4 are sufficient.

---

### P2-3 (nice-to-have): Volta footnote omits a known sharp edge with `volta pin`

**Where**: ch02 §Volta (lines 48-57); ch05 §onboarding Volta footnote
(lines 144-145).

**Issue**: `volta pin node@22` writes `package.json#volta.node:
"22.x.x"` (exact patch). If a Volta user runs the command, the diff
is non-trivially large and they may commit it by accident. The spec
mentions this risk in ch02 ("we gitignore that diff via a `.gitignore`
rule on the `volta` block, OR we document the manual pin") and says
"Recommended: the manual one-time step." But the spec does not
provide a concrete pre-commit guard or a `git config` recipe to keep
the `volta` block out of commits.

**Why P2**: Affects only Volta users (a minority); footgun rather
than ship-blocker.

**Suggested fix**: Add to ch05 onboarding Volta footnote: "If you
accidentally commit a `volta` block in `package.json`, it gets
flagged by [insert linter / CI grep TBD]. To avoid: after `volta pin
node@22`, run `git checkout -- package.json` to drop the diff;
Volta still uses the pin from local cache." Or add a `pre-commit`
hook example that strips `package.json#volta` before commit.

---

## Cross-file findings

(Findings touching multiple chapters — flag for single-fixer
assignment to keep consistency.)

### CF-1: `node-linker=hoisted` provenance disagreement

ch03 implies it's already there; ch04 adds it; ch06 lists it as
missing. Reality: it is not there. **All three chapters must agree:
THIS spec adds it as part of PR D, and v0.3's `packages/electron`
build is non-functional on Windows until it lands.** See P0-2.

### CF-2: PR D file list must reflect actual `working` state

ch04 §root .npmrc, ch03 §workspace configuration, and ch06 §v0.2
main rollout PR D list overlap and contradict. Single fixer should
rewrite ch06 PR D file-by-file, then back-reference from ch03/ch04.
See P0-1, P0-2.

### CF-3: pnpm version pin scope mismatch

ch03 (exact) vs ch04 (`10.x` range) for pnpm. Pick one; propagate to
ch06 done criteria + Renovate (v0.4 deferred) section. See P1-4.

### CF-4: Forward-compat for v0.4 binary signing / Connect-RPC packaging

ch01 forever-stable claim assumes pure-Node toolchain concerns; v0.4
adds daemon binary packaging that introduces Node-version
constraints on the packager itself. Cross-reference to daemon-split
spec needed in ch01 §relation to other specs. See P1-5.

---

## Summary

- **P0**: 3 (PR D file list desync; node-linker provenance disagreement
  across 3 chapters; pnpm-lock.yaml provenance unverified)
- **P1**: 5 (cache key node-version literal; release-script bash
  precheck; corepack signature behind proxy; engines.pnpm range too
  loose; v0.4 daemon binary forward-compat blind spot)
- **P2**: 3 (PR #848 staleness; done-criteria 5 unmeasurable; Volta
  pin footgun)
- **Cross-file**: 4 (node-linker provenance, PR D file list, pnpm
  version pin scope, forward-compat to daemon binary)

**Zero-rework verdict**: Spec largely respects the principle (Volta
footnote correctly avoids `package.json#volta`; engines+`.nvmrc`
+`packageManager` are all hard locks with no v0.4 placeholder; CI
diff is forward-compatible with the v0.4 Connect-RPC plan because it
just sets up Node + pnpm and doesn't touch RPC infra). However, three
P0s would each force a follow-up PR (= rework) if shipped as-is:

1. PR D regenerating the existing pnpm-lock.yaml needlessly.
2. node-linker=hoisted skipped by a fixer following ch03's misleading
   "already in place" wording → Windows build breaks → fix-up PR.
3. Lockfile provenance mismatch surfacing only on first contributor
   `pnpm install` post-merge → rebuild PR.

Recommendation: address all three P0s before R0 sign-off.
