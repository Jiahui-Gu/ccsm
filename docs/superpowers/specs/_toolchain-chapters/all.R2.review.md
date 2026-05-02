# R2 review — supply-chain security

Reviewer angle: **R2 — supply-chain security**. Toolchain pinning is itself a
supply-chain attack surface. Findings rated by genuine risk per the project's
pragmatic gradient: **P0 = real supply-chain risk that ships exploitable
state**; **P1 = defense-in-depth gap that meaningfully widens the attack
window**; **P2 = best-practice nice-to-have**. R2 is explicitly pragmatic —
no P0 inflation.

Scope: all six chapters
(`ch01-overview.md` … `ch06-rollout.md`).

---

## Summary

| # | Severity | Topic | Chapter |
|---|---|---|---|
| 1 | P1 | `packageManager` lacks `+sha512.<hash>` integrity suffix | ch03 |
| 2 | P1 | No `pnpm install --frozen-lockfile` reverse-verify in §verification list | ch03 / ch04 / ch05 |
| 3 | P2 | `.nvmrc` major-only is correct decision but missing threat-model paragraph | ch02 |
| 4 | P2 | `setup-node@v4` Node-binary signature trust model not documented | ch02 / ch05 |
| 5 | P2 | Native-module (`better-sqlite3`, `node-pty`) prebuild trust unaddressed | ch03 / ch06 |
| 6 | P2 | CONTRIBUTING does not warn against `corepack disable` / global pnpm override | ch05 |
| 7 | P2 | `node-linker=hoisted` widens phantom-dep surface — call out the trade | ch03 / ch04 |
| 8 | P2 | Release-candidate verify checks versions but not lockfile drift | ch05 |

Total: **0 P0, 2 P1, 6 P2**. Spec is fundamentally sound from a supply-chain
view. The P1 items are defense-in-depth tightenings worth doing in the same
ship; the P2 items are documentation/comment additions.

---

## Detailed findings

### Finding 1 — `packageManager` lacks integrity suffix (P1)

**Where**: `ch03 §decision`, lines 10-16; `ch01 §cross-version conventions`,
line 71-76.

**Issue**: Spec pins pnpm as `"packageManager": "pnpm@10.33.2"`. Corepack
Node 16.9+ supports an OPTIONAL integrity suffix:

```json
"packageManager": "pnpm@10.33.2+sha512.<128-hex>"
```

When the hash is present, Corepack verifies the downloaded pnpm tarball
against it before activation. Without the hash, Corepack trusts the npm
registry response (TLS + registry signing — no application-layer pin).

The supply-chain attack this defeats: a compromised npm registry account
republishing `pnpm@10.33.2` with malicious bytes. With the hash in
`packageManager`, every contributor and every CI job fails activation
immediately. Without it, the malicious pnpm runs once and can ex-filtrate
secrets / poison the lockfile during `pnpm install`.

The cost is one-line: append the hash from
[pnpm/pnpm releases](https://github.com/pnpm/pnpm/releases) (or
`npm view pnpm@10.33.2 dist.integrity`). Renovate (deferred to v0.4) supports
auto-bumping the hash alongside the version.

**Why P1 not P0**: npm registry compromise of a specific version is rare,
and Corepack 0.32+ began verifying npm-published `dist.integrity` even
without the explicit suffix on some platforms. But the suffix is the only
mechanism that gives a CI-time, application-controlled hash check. The cost
is a single line; the benefit is a real defense-in-depth layer.

**Recommendation**: Update `ch03 §decision` to specify the
`pnpm@10.33.2+sha512.<hash>` form, with a short paragraph explaining the
threat model (registry compromise) and the trivial cost. Add a note that
Renovate (v0.4) bumps both fields atomically.

---

### Finding 2 — `--frozen-lockfile` not in reverse-verify (P1)

**Where**: `ch03 §verification` lines 132-141; `ch04 §verification` lines
168-176; `ch05 §reverse-verify matrix` lines 207-218.

**Issue**: `ch03 §CI` and `ch05 §CI` correctly mandate `pnpm install
--frozen-lockfile` in CI. But the **verification** sections (§verification
in ch03, ch04, and the per-row criteria in ch05) check version equality and
exit codes, not lockfile-drift behavior.

A frozen-lockfile gate is a supply-chain control: it prevents a contributor
who edits `package.json` (e.g., adds a new dep) from silently regenerating
`pnpm-lock.yaml` in CI. Without that gate enforced, an attacker who
compromises a contributor account can land a `package.json` change whose
real dependency surface (reflected in the auto-regenerated lockfile) is
larger than the diff suggests.

ch05 §per-row pass criteria says "no lockfile diff" but doesn't say HOW the
verifier confirms — it should explicitly invoke `pnpm install
--frozen-lockfile` (which exits non-zero on drift) rather than `pnpm install`
(which silently rewrites).

**Recommendation**:
- ch03 §verification: change "exits 0 with no lockfile modification" to an
  explicit step: `pnpm install --frozen-lockfile && git diff --exit-code
  pnpm-lock.yaml`.
- ch05 §reverse-verify per-row pass criteria, line 211: same explicit
  command sequence.
- ch04 §verification: add a fourth bullet — `pnpm install --frozen-lockfile`
  on a host where `package.json` was hand-edited to add a phantom dep
  exits non-zero.

**Why P1**: the gate exists in CI (`ch03 §CI`); finding is about making the
verification matrix reproduce the gate so future regressions (e.g., someone
"fixes flaky CI" by dropping `--frozen-lockfile`) are caught.

---

### Finding 3 — `.nvmrc` major-only: threat-model paragraph missing (P2)

**Where**: `ch02 §file contents` lines 16-33.

**Issue**: The spec correctly chose `22` (major-only) and gives the *operational*
rationale (latest patch, NODE_MODULE_VERSION 127 stable, no manual CVE
bumps). Good decision — pinning the patch would force the project to trail
upstream security fixes.

However, the chapter does not name the supply-chain trade explicitly: a
patch-level pin would defeat a hypothetical "compromised Node.js binary
republished under same version" attack, but at the cost of trailing real
CVEs by weeks. The spec made the right call (security-driven mutability >
attack-surface immutability) but a one-paragraph mention would forestall a
future R2-style review proposing a patch pin.

**Recommendation**: Add to `ch02 §file contents` a short paragraph:

> Why not pin patch (e.g. `22.11.0`): a patch pin would block silent
> upstream binary republishing, but at the cost of weeks of CVE lag. We
> choose the operational risk (trust setup-node + nodejs.org TLS) over the
> security-update risk (manual bumps every patch). This is a deliberate
> supply-chain trade, not an oversight.

---

### Finding 4 — setup-node Node binary signature trust (P2)

**Where**: `ch02 §CI consumption` lines 66-92; `ch05 §CI` lines 41-65.

**Issue**: `actions/setup-node@v4` downloads Node binaries from
`nodejs.org/dist/`. It verifies SHA256 from the published `SHASUMS256.txt`
but does NOT verify the GPG signature on `SHASUMS256.txt.sig` against the
Node release-team keys. For CCSM's risk profile this is acceptable (matches
industry default), but the spec should acknowledge it.

The supply-chain failure mode: `nodejs.org` mirror compromise serves a
malicious `node` binary plus matching `SHASUMS256.txt`; setup-node
"verifies" successfully because the malicious shasum matches the malicious
binary. GPG-sig verification would catch this; SHA-only does not.

Mitigation in CCSM's environment: GitHub-hosted runners (`ubuntu-latest`,
`macos-latest`, `windows-latest`) come with a pre-installed Node toolcache;
setup-node prefers the cached version. The risk is real only on cache miss
+ download.

**Recommendation**: Add to `ch05 §CI` a one-paragraph note documenting the
trust boundary: "We trust setup-node@v4's pinned-by-tag GHA + nodejs.org
SHA256. We do NOT independently verify the Node binary GPG signature; that
would require a custom step. Accepted residual risk." This is an explicit
acknowledgment, not a code change.

---

### Finding 5 — Native-module prebuild trust model (P2)

**Where**: `ch03 §workspace configuration` lines 100-117 (mentions
`better-sqlite3`, `node-pty` for layout reasons); `ch06 §contributor-environment
fallback` lines 138-141 (mentions native build failures).

**Issue**: `better-sqlite3` and `node-pty` ship prebuilt binaries via the
`prebuild-install` mechanism (downloads from a GitHub release URL or an
npm-resolved tarball). The spec doesn't address:

- Are prebuilds trusted? (Default: yes, with no signature check beyond the
  npm package integrity hash in `pnpm-lock.yaml`.)
- What happens if a prebuild URL serves a compromised binary? (Currently:
  it runs.)
- Should CCSM force `--build-from-source` for sensitive natives?

For CCSM's risk profile (developer tool, not a hardened production service),
trusting prebuilds is the right call — building from source on Windows
requires VS BuildTools setup that has been a recurring contributor pain
point (and is the reason `clang=0` is in `.npmrc`). But the trust model
should be documented.

The protective layer that DOES exist: `pnpm-lock.yaml` records the npm
tarball integrity hash; `--frozen-lockfile` enforces it. So a republished
npm package would fail the lockfile gate. The remaining gap is the
out-of-band prebuild download URL the package itself fetches at install
time.

**Recommendation**: Add a short subsection to `ch03` (or to `ch06
§contributor-environment fallback`) — "Native module prebuild trust" —
naming the trust chain (npm package integrity → prebuild-install URL,
not independently signed) and the accepted residual risk. No code change.

---

### Finding 6 — CONTRIBUTING does not warn against bypass (P2)

**Where**: `ch05 §onboarding` lines 102-137.

**Issue**: The onboarding instructs `corepack enable` (good) but does not
warn against the common bypass paths:

- `corepack disable` (sometimes recommended in Stack Overflow answers when
  Corepack has a bug)
- `npm i -g pnpm` followed by ignoring the `packageManager` field
- Setting `COREPACK_ENABLE_STRICT=0` (which the spec mentions in `ch04
  §verification` but only as a verification trick, not as a thing to NOT
  set in normal use)

These are the realistic ways a contributor "fixes" a Corepack issue and
ends up with the wrong pnpm. A divergent pnpm produces a divergent
lockfile, which is the exact supply-chain drift this whole spec exists to
prevent.

**Recommendation**: Add to the CONTRIBUTING block in `ch05 §onboarding` a
final fenced paragraph:

> ### Do not bypass the pin
>
> If something goes wrong with Corepack, do NOT run `corepack disable`,
> `npm i -g pnpm`, or set `COREPACK_ENABLE_STRICT=0` as a workaround. These
> install a different pnpm than `package.json#packageManager` says, which
> produces lockfile drift. Instead, follow the
> "Contributor-environment fallback playbook" in CONTRIBUTING (the content
> referenced from `ch06`) and report the issue.

---

### Finding 7 — `node-linker=hoisted` phantom-dep surface (P2)

**Where**: `ch03 §workspace configuration` lines 100-117; `ch04 §root .npmrc`
final file lines 67-78.

**Issue**: `node-linker=hoisted` is correctly chosen (Electron + native
modules need flat `node_modules`). Supply-chain trade: hoisted layout
re-introduces npm's "phantom dependency" problem — a package can `require()`
a transitive dep that isn't in its own `package.json`. That makes it harder
to audit which packages CCSM CODE actually depends on vs. which are just
hoisted siblings.

This is a known pnpm trade and the spec correctly accepts it for Electron
compat reasons. The R2 concern is just that `ch03` and `ch04` don't name
the trade explicitly; future readers might not realize they gave up pnpm's
strict-resolution security property.

**Recommendation**: Append one sentence to `ch03 §workspace configuration`:
"Trade-off: `hoisted` re-enables npm-style phantom dependencies; a package
can `require()` any hoisted sibling. We accept this for Electron compat;
auditing real first-party deps requires reading `package.json` not
`node_modules/`."

---

### Finding 8 — Release-candidate verify misses lockfile drift (P2)

**Where**: `ch05 §release-candidate verify` lines 148-183.

**Issue**: The release-candidate preflight checks Node version and pnpm
version. It does NOT check `pnpm install --frozen-lockfile` (i.e., that the
local `pnpm-lock.yaml` matches `package.json` and was not edited
post-install on the release machine).

The release-time supply-chain mistake this defeats: a release manager runs
`pnpm install` (without `--frozen-lockfile`) on a release machine where
`package.json` was edited locally (e.g., bumping a dep last-minute).
`pnpm-lock.yaml` regenerates silently; the release ships a different
dependency set than what was reviewed/merged.

The cost is two extra lines in the preflight script:

```bash
pnpm install --frozen-lockfile >/dev/null
git diff --exit-code pnpm-lock.yaml package.json
```

**Why P2 not P1**: assumes a release manager who ran a local `pnpm install`.
Less likely than the install-time drift addressed by Finding 2 (which is
P1). But the marginal cost is two lines and the marginal value is a real
ship-time guarantee.

**Recommendation**: Append the two lines to the script in `ch05
§release-candidate verify`.

---

## Cross-cutting note: spec is sound

This spec correctly identifies that toolchain pinning IS a supply-chain
control (ch01 §context implicitly; ch04 §decision explicitly via "wrong
host = hard fail at install"). The choice of mechanisms (Corepack over
`pnpm/action-setup`, `engine-strict` over postinstall assertion,
`--frozen-lockfile` in CI, `engines` ranges with exact pin elsewhere) all
follow current best practice. The findings above are TIGHTENINGS, not
corrections — none of them rise to "this design has a real supply-chain
hole" (which would be P0).

The two P1 items (`+sha512` suffix, frozen-lockfile in verification matrix)
are worth landing in the same ship because the cost is trivial and they
close real defense-in-depth gaps. The six P2 items are documentation /
trust-model clarifications that future readers and reviewers will benefit
from.

No P0 findings. Proceed to fix.
