# T9.12 — macOS notarization for Node 22 SEA (hardened runtime + JIT)

Spike for Task #111. Pinned by spec ch14 §1.13.

Validates the Apple codesign + notarization recipe for the v0.3 daemon's
SEA-built Node 22 binary so that, on macOS, T7.1 (sea pipeline, Issue #84)
can ship a Gatekeeper-approved daemon executable that still has a working
JIT (V8 needs `allow-jit` + `allow-unsigned-executable-memory` under the
hardened runtime).

## TL;DR

- Probe scaffolding + entitlements + Info.plist sample landed.
- **Phase 0 of the notarization pipeline is BLOCKED** on the
  `Apple Dev ID Application` certificate prerequisite (ops gate, see below).
- All probe code paths, gating, and recipe steps are pinned in this PR so
  that as soon as the cert is provisioned + a notarytool keychain profile is
  stored, `bash notarize.sh` can run unattended on a `macos-latest` runner
  without further code changes.

## Per-OS results

| OS      | Built? | Signed? | Notarized? | Stapled? | spctl OK? | Notes                                              |
|---------|--------|---------|------------|----------|-----------|----------------------------------------------------|
| darwin  | TODO   | TODO    | TODO       | TODO     | TODO      | **Blocked on Apple Dev ID cert (ops gate)**        |
| win32   | n/a    | n/a     | n/a        | n/a      | n/a       | macOS-only step                                    |
| linux   | n/a    | n/a     | n/a        | n/a      | n/a       | macOS-only step                                    |

Run host attempted: `MINGW64_NT-10.0-26200` (Windows 11). The probe's gate
check fired correctly:

```
$ bash tools/spike-harness/probes/macos-notarization-sea/notarize.sh
[notarize] GATE: non-darwin host (MINGW64_NT-10.0-26200); macOS notarization requires macOS.
exit 20
```

That confirms the probe fails fast (exit 20 = gate not satisfied) without
attempting anything destructive on a non-macOS host.

## Files in this probe

| File                   | Role                                                                 |
|------------------------|----------------------------------------------------------------------|
| `notarize.sh`          | End-to-end pipeline: codesign + notarytool submit + staple + spctl.  |
| `Info.plist`           | Bundle metadata embedded into the Mach-O at codesign time.           |
| `PROBE-RESULT.md`      | This file. Documents gate, recipe, and follow-ups.                   |

The hardened-runtime entitlements file is **not duplicated here**; it is the
shared, forever-stable fixture at `tools/spike-harness/entitlements-jit.plist`
(spec ch14 §1.B). `notarize.sh` references it via relative path
`../../entitlements-jit.plist`. Duplicating it would split the contract.

The SEA binary itself is **not produced here**; it is the output of the
T9.9 sibling probe `tools/spike-harness/probes/sea-3os/build.sh` running on
darwin. `notarize.sh` consumes its absolute path via `$SEA_BINARY`.

## Reproduction (once the gate is satisfied)

On a `macos-latest` host with Xcode 13+ and a populated keychain:

```bash
# 1) Build the SEA binary first (T9.9 sibling probe).
bash tools/spike-harness/probes/sea-3os/build.sh
SEA_BIN="$PWD/tools/spike-harness/probes/sea-3os/dist/sea-hello-darwin"

# 2) Configure Apple credentials (one-time per host).
xcrun notarytool store-credentials ccsm-notary \
      --apple-id "<release-bot@yourdomain>" \
      --team-id  "XXXXXXXXXX" \
      --password "<app-specific-password>"

# 3) Run the notarization probe.
APPLE_TEAM_ID=XXXXXXXXXX \
APPLE_SIGNING_IDENTITY="Developer ID Application: Acme Co (XXXXXXXXXX)" \
APPLE_NOTARY_PROFILE=ccsm-notary \
SEA_BINARY="$SEA_BIN" \
bash tools/spike-harness/probes/macos-notarization-sea/notarize.sh
```

Expected on success: `dist/<binary>.signed` produced, `dist/notarize.log`
shows `OK — signed+notarized binary at …`, exit 0.

## Recipe — exact codesign + notarytool invocation

Pinned in `notarize.sh`; reproduced here for spec / review purposes.

```bash
codesign --sign "$APPLE_SIGNING_IDENTITY" \
         --options runtime \
         --entitlements ../../entitlements-jit.plist \
         --identifier "$BUNDLE_ID" \
         --timestamp \
         --force \
         "$SEA_BINARY"

ditto -c -k --keepParent "$SEA_BINARY" dist/submit.zip

xcrun notarytool submit dist/submit.zip \
      --keychain-profile "$APPLE_NOTARY_PROFILE" \
      --wait \
      --output-format json
# assert .status == "Accepted"

xcrun stapler staple "$SEA_BINARY" || true   # bare Mach-O can't embed ticket;
                                               # ticket lives on Apple's CDN.
spctl --assess --type execute --verbose=4 "$SEA_BINARY"
```

### Why these flags

- `--options runtime` — opts the binary into the **hardened runtime**, which
  Apple requires for notarization. Without it, `notarytool submit` returns
  `Invalid` with `"The executable does not have the hardened runtime
  enabled."`
- `--entitlements ../../entitlements-jit.plist` — grants `allow-jit` and
  `allow-unsigned-executable-memory`. Both are required by V8 inside Node;
  omitting `allow-unsigned-executable-memory` causes V8 startup to crash
  with `EXC_BAD_ACCESS (SIGKILL Code Signature Invalid)` on first JIT
  emit. Source: Apple TN3127 + Node v22.x macOS build notes.
- `--timestamp` — embeds a secure timestamp from Apple's TSA. Mandatory for
  notarization; submissions without it are rejected.
- `--identifier "$BUNDLE_ID"` — must match `CFBundleIdentifier` in the
  embedded Info.plist or `notarytool` rejects with `"Bundle ID mismatch"`.
- `ditto -c -k --keepParent` — `notarytool` only accepts `.zip`, `.dmg`, or
  `.pkg`. A bare Mach-O is rejected with `"Asset has unsupported format"`.
- `--wait --output-format json` — synchronous + machine-parseable so CI can
  fail fast on `status != Accepted` without polling.
- `stapler staple` is best-effort: a bare Mach-O has no `__TEXT,__notarize`
  section to staple a ticket into, so the ticket is served from Apple's CDN
  on first launch. We rely on `spctl --assess` to confirm Gatekeeper
  accepts the binary post-notarization.

## Gate / blockers

### Hard blocker (phase 0): Apple Developer ID Application certificate

`notarize.sh` exits **20** until **all** of the following are true:

1. **Apple Developer Program enrollment** for the org account that will
   sign + ship `ccsm`. ($99 USD/yr; 1-3 business days for new enrollments.)
2. **`Developer ID Application` certificate** issued from
   <https://developer.apple.com/account/resources/certificates/list> and
   imported into the macOS runner's login keychain (or a dedicated
   keychain pinned by the build job). This is the cert whose CN appears as
   `APPLE_SIGNING_IDENTITY` (e.g. `Developer ID Application: Acme Co (XXXXXXXXXX)`).
3. **App-specific password** generated at <https://appleid.apple.com> for
   the Apple ID that owns the team, and stored in the runner's keychain via:
   ```
   xcrun notarytool store-credentials ccsm-notary \
         --apple-id "<release-bot@yourdomain>" \
         --team-id  "XXXXXXXXXX" \
         --password "<app-specific-password>"
   ```
4. **`APPLE_TEAM_ID`**, **`APPLE_SIGNING_IDENTITY`**, **`APPLE_NOTARY_PROFILE`**,
   **`SEA_BINARY`** env vars set in the CI job.
5. A `macos-latest` runner with Xcode 13+ (`xcrun --find notarytool`
   resolves) — GitHub-hosted `macos-13` and `macos-14` images both qualify.

This is an **ops prereq**, not a code task. Per the task description: "ops
prereq (Apple Dev ID cert) blocks phase 0." File the ops ticket against
whoever owns the Apple Developer account; this PR cannot unblock it.

### Soft considerations

- **Self-hosted vs. GitHub-hosted macOS runners.** GitHub-hosted runners are
  ephemeral, so credentials must be injected per job from GitHub secrets +
  written into a temp keychain. Long-term we may prefer a self-hosted
  runner (Task #16 / T0.10) so the Dev ID cert lives on disk and survives
  reboots; tradeoff is maintenance.
- **App-specific password rotation.** Apple expires app-specific passwords
  if unused for 12 months; release pipeline should fail loudly (exit 22)
  rather than silently re-emit unsigned binaries.
- **Stapling on bare Mach-O.** As noted, the ticket lives on Apple's CDN. If
  v0.4 wraps the daemon in a `.app` bundle (e.g. for LaunchAgent install),
  `stapler staple` will start succeeding and offline-first launch will
  benefit. No code change needed in this probe — `stapler staple … || true`
  already tolerates both shapes.

## Recommendation for T7.1 (#84 sea pipeline)

**GREEN to wire `notarize.sh` in as the post-build step on the macOS leg of
T7.1**, gated on a non-empty `APPLE_SIGNING_IDENTITY` env var so that:

- Local devs running `build.sh` without Apple credentials get an unsigned
  binary (warned, not failed).
- CI jobs with secrets configured produce a notarized, Gatekeeper-clean
  binary in one shot.
- The hardened-runtime entitlements stay co-located in
  `tools/spike-harness/entitlements-jit.plist` (forever-stable per ch14
  §1.B), preventing drift between the spike and the shipping pipeline.

Live execution remains TODO behind the ops gate above.

## Follow-ups

1. **Ops:** open a separate ticket to provision the `Developer ID
   Application` cert + notarytool keychain profile on the macOS runner.
   Cite this probe as the consumer.
2. **CI wiring (T7.1 / T0.10):** add a job that runs `bash
   tools/spike-harness/probes/macos-notarization-sea/notarize.sh` on
   `macos-latest` after the SEA build, with secrets piped through env.
   Block T7.1 macOS green on `notarize.sh` exit 0.
3. **Re-record this file** with real `notarytool` output (`status:
   Accepted`, submission id, log URL, `spctl --assess` line) on first
   successful run; update the per-OS table.
4. **Consider `.app` wrapping** for v0.4 if we want offline-first first-run
   (stapled ticket vs. CDN fetch). Not on the v0.3 critical path.
