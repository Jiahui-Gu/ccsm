# release-keys/

Public keys + verification metadata for ccsm release artifacts.

| File | Purpose |
|------|---------|
| `minisign.pub` | Public half of the ccsm release-signing minisign keypair. Used by `minisign -V` and the daemon-side updater verifier. **Currently a placeholder** — see "First-time keypair generation" below. |

The matching **private** key is **never** committed. It lives only in the
GitHub Actions repo secret `MINISIGN_PRIVATE_KEY` (with the unlock password
in `MINISIGN_PASSWORD`). Both are referenced by `.github/workflows/release.yml`
in the `attest` job.

## Sidecar files produced per release

For every installer artifact (`*.exe`, `*.dmg`, `*.AppImage`, `*.deb`,
`*.rpm`, `*.zip`) the release workflow publishes three sidecar files:

| Sidecar | Producer | Verify with |
|---------|----------|-------------|
| `<artifact>.sha256` | `sha256sum` step in the `attest` job | `sha256sum -c <artifact>.sha256` |
| `<artifact>.intoto.jsonl` | `slsa-framework/slsa-github-generator/.github/workflows/generator_generic_slsa3.yml@v2.0.0` reusable workflow | [`slsa-verifier verify-artifact`](https://github.com/slsa-framework/slsa-verifier) — see README "Verify your download" |
| `<artifact>.minisig` | `minisign -S` step in the `attest` job, signed with the key from `MINISIGN_PRIVATE_KEY` | `minisign -V -p release-keys/minisign.pub -m <artifact>` |

The `publish` job in `.github/workflows/release.yml` runs a **sidecar-verify
gate** that refuses to publish a draft release unless all three sidecars are
present (and non-empty) for every installer.

## First-time keypair generation (release-day ops, NOT in CI)

Run this once on a trusted operator machine (offline preferred). The keypair
is for ccsm release signing only — do not reuse personal minisign keys.

```bash
# 1. Generate a fresh keypair. You will be prompted for an unlock password —
#    use a strong one and store it in a password manager. The password ALSO
#    needs to be stored in the MINISIGN_PASSWORD repo secret (below).
minisign -G -p ccsm-minisign.pub -s ccsm-minisign.key

# 2. Commit ccsm-minisign.pub to this directory as `minisign.pub`, replacing
#    the placeholder. Open a PR (this is the public half — safe to commit).
cp ccsm-minisign.pub release-keys/minisign.pub

# 3. Provision the private key as a GitHub Actions repo secret. The secret
#    value is the FULL CONTENTS of ccsm-minisign.key (including the
#    "untrusted comment:" header lines).
gh secret set MINISIGN_PRIVATE_KEY --repo Jiahui-Gu/ccsm < ccsm-minisign.key

# 4. Provision the unlock password as a separate secret.
gh secret set MINISIGN_PASSWORD --repo Jiahui-Gu/ccsm
# (paste password when prompted)

# 5. Securely delete the on-disk private key. The repo secret + your password
#    manager are now the only copies.
shred -u ccsm-minisign.key
```

After step 5, the next tag push triggers `release.yml`, the `attest` job
signs every installer, and the sidecar-verify gate passes.

## Key rotation

Rotation is required when:

- A repo collaborator with `MINISIGN_PRIVATE_KEY` access leaves the project.
- Suspected secret leak (CI log scrape, accidental `printenv`, etc.).
- Scheduled rotation (recommended: yearly, but not yet enforced).

Procedure:

1. Generate a new keypair as in "First-time keypair generation" steps 1–2.
2. Commit the new `minisign.pub` in a PR titled `release-keys: rotate minisign keypair (YYYY-MM-DD)`. Reference the rotation reason in the PR body.
3. Update `MINISIGN_PRIVATE_KEY` + `MINISIGN_PASSWORD` repo secrets (steps 3–4).
4. Tag a patch release (e.g. `v0.3.1`) so the new key is exercised end-to-end before any rotation reaches user-facing release notes.
5. In the next user-facing release notes, document the rotation: "Release-signing key rotated on YYYY-MM-DD. Old fingerprint: `<sha256 of old minisign.pub>`. New fingerprint: `<sha256 of new minisign.pub>`."
6. Securely delete the on-disk private key (step 5 of generation).

The **old** public key MUST stay in git history (do not force-push to
remove it). Users verifying older releases need the matching old public key
to verify older `.minisig` files; the simplest path is `git log -- release-keys/minisign.pub` + checkout the historical revision.

## Disaster: private key suspected leaked

1. **Immediately revoke** the GitHub Actions secret: `gh secret delete MINISIGN_PRIVATE_KEY --repo Jiahui-Gu/ccsm`. Without the secret, the `attest` job writes empty `.minisig` files and the sidecar-verify gate fails closed — no further releases can ship signed with the compromised key.
2. Open a high-priority issue on the repo describing the suspected leak.
3. Run the rotation procedure above.
4. Publish a security advisory (`gh api repos/Jiahui-Gu/ccsm/security-advisories -f summary='Release-signing key rotation' ...`) listing every release that was signed with the compromised key. Users should re-verify those releases against the historical public key (still valid for those specific binaries; the SLSA L3 attestation provides an independent authenticity check that does NOT depend on minisign).
