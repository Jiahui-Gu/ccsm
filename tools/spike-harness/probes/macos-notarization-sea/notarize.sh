#!/usr/bin/env bash
# notarize.sh — Notarize a Node 22 SEA binary with hardened runtime + JIT (T9.12).
#
# Spike for Task #111. Pinned by spec ch14 §1.13.
#
# Contract (forever-stable per ch14 §1.B):
#   Inputs (env):
#     APPLE_TEAM_ID            — 10-char Apple Developer team identifier
#     APPLE_SIGNING_IDENTITY   — exact `security find-identity` line, e.g.
#                                "Developer ID Application: Acme Co (XXXXXXXXXX)"
#     APPLE_NOTARY_PROFILE     — `xcrun notarytool store-credentials` keychain
#                                profile name holding Apple ID + app-specific pw
#     SEA_BINARY               — absolute path to the SEA-built Node binary
#                                (produced by ../sea-3os/build.sh)
#   Inputs (files, sibling to this script):
#     ../../entitlements-jit.plist   — canonical hardened-runtime entitlements
#                                      (allow-jit + allow-unsigned-executable-memory)
#     Info.plist                     — bundle metadata for the Mach-O
#
#   Outputs:
#     dist/<basename>.signed         — signed + notarized + stapled Mach-O
#     dist/notarize.log              — full pipeline log
#     dist/notarytool-submission.json — `notarytool submit --output-format json`
#
#   Exit:
#     0   — sign + submit + Accepted + staple all succeeded; binary verifies.
#     20  — gate not satisfied (missing env / non-darwin / missing toolchain).
#     21  — codesign failed.
#     22  — notarytool submit failed or returned non-Accepted status.
#     23  — staple / verify failed.
#
# Algorithm (per Apple TN3147 + `notarytool` 2025 docs):
#   0. Gate: refuse on non-darwin or when any required env var is unset.
#      This is the documented Apple Dev ID cert prerequisite (see PROBE-RESULT.md).
#   1. codesign --sign "$APPLE_SIGNING_IDENTITY" --options runtime
#               --entitlements ../../entitlements-jit.plist
#               --identifier "$BUNDLE_ID"
#               --info-plist Info.plist
#               --timestamp --force
#               "$SEA_BINARY"
#   2. ditto -c -k --keepParent "$SEA_BINARY" dist/submit.zip
#      (notarytool requires zip / dmg / pkg input; bare Mach-O is rejected)
#   3. xcrun notarytool submit dist/submit.zip
#               --keychain-profile "$APPLE_NOTARY_PROFILE"
#               --wait --output-format json
#               > dist/notarytool-submission.json
#      Assert .status == "Accepted".
#   4. xcrun stapler staple "$SEA_BINARY" || true   # bare Mach-O cannot be
#      stapled; the notarization ticket lives in Apple's CDN. We instead
#      verify with `spctl -a -vv -t install` to confirm Gatekeeper is happy.
#   5. codesign --verify --deep --strict --verbose=2 "$SEA_BINARY"
#      spctl --assess --type execute --verbose=4 "$SEA_BINARY"
#
# Layer 1: bash + Apple's bundled `codesign` / `xcrun notarytool` / `stapler`
# / `spctl` / `ditto`. No npm deps.
#
# This probe DOES NOT RUN until the Apple Dev ID cert + notarytool keychain
# profile gate is satisfied (see PROBE-RESULT.md §"Gate / blockers").

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/dist"
ENTITLEMENTS="$HERE/../../entitlements-jit.plist"
INFO_PLIST="$HERE/Info.plist"

mkdir -p "$DIST"
: > "$DIST/notarize.log"
log() { echo "[notarize] $*" | tee -a "$DIST/notarize.log"; }

# ---- 0. gate ----
if [ "$(uname -s)" != "Darwin" ]; then
  log "GATE: non-darwin host ($(uname -s)); macOS notarization requires macOS."
  exit 20
fi

MISSING=()
[ -n "${APPLE_TEAM_ID:-}" ]           || MISSING+=("APPLE_TEAM_ID")
[ -n "${APPLE_SIGNING_IDENTITY:-}" ]  || MISSING+=("APPLE_SIGNING_IDENTITY")
[ -n "${APPLE_NOTARY_PROFILE:-}" ]    || MISSING+=("APPLE_NOTARY_PROFILE")
[ -n "${SEA_BINARY:-}" ]              || MISSING+=("SEA_BINARY")
if [ ${#MISSING[@]} -gt 0 ]; then
  log "GATE: missing required env: ${MISSING[*]}"
  log "      See PROBE-RESULT.md §'Gate / blockers' for the cert provisioning steps."
  exit 20
fi

for tool in codesign xcrun ditto spctl; do
  command -v "$tool" >/dev/null 2>&1 || { log "GATE: missing tool: $tool"; exit 20; }
done
xcrun --find notarytool >/dev/null 2>&1 || { log "GATE: notarytool not in xcrun (need Xcode 13+)"; exit 20; }
xcrun --find stapler    >/dev/null 2>&1 || { log "GATE: stapler not in xcrun"; exit 20; }

[ -f "$ENTITLEMENTS" ] || { log "GATE: entitlements plist missing at $ENTITLEMENTS"; exit 20; }
[ -f "$INFO_PLIST" ]   || { log "GATE: Info.plist missing at $INFO_PLIST"; exit 20; }
[ -f "$SEA_BINARY" ]   || { log "GATE: SEA_BINARY does not exist: $SEA_BINARY"; exit 20; }

BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
BIN_BASENAME="$(basename "$SEA_BINARY")"
log "team=$APPLE_TEAM_ID identity=$APPLE_SIGNING_IDENTITY profile=$APPLE_NOTARY_PROFILE"
log "binary=$SEA_BINARY ($(stat -f %z "$SEA_BINARY") bytes) bundle-id=$BUNDLE_ID"

# ---- 1. codesign with hardened runtime + JIT entitlements ----
log "step 1: codesign --options runtime + JIT entitlements"
codesign --sign "$APPLE_SIGNING_IDENTITY" \
         --options runtime \
         --entitlements "$ENTITLEMENTS" \
         --identifier "$BUNDLE_ID" \
         --timestamp \
         --force \
         "$SEA_BINARY" >> "$DIST/notarize.log" 2>&1 || { log "FAIL step 1: codesign"; exit 21; }

# Verify the signature locally before submitting (cheap fail-fast).
codesign --verify --deep --strict --verbose=2 "$SEA_BINARY" >> "$DIST/notarize.log" 2>&1 \
  || { log "FAIL step 1 verify: codesign --verify"; exit 21; }

# ---- 2. zip for notarytool ----
log "step 2: ditto -> dist/submit.zip"
SUBMIT_ZIP="$DIST/submit.zip"
rm -f "$SUBMIT_ZIP"
ditto -c -k --keepParent "$SEA_BINARY" "$SUBMIT_ZIP"

# ---- 3. notarytool submit --wait ----
log "step 3: notarytool submit --wait"
SUBMISSION_JSON="$DIST/notarytool-submission.json"
xcrun notarytool submit "$SUBMIT_ZIP" \
      --keychain-profile "$APPLE_NOTARY_PROFILE" \
      --wait \
      --output-format json \
      > "$SUBMISSION_JSON" 2>> "$DIST/notarize.log" \
      || { log "FAIL step 3: notarytool submit (see $SUBMISSION_JSON)"; exit 22; }

STATUS="$(/usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('status',''))" "$SUBMISSION_JSON")"
log "notarytool status=$STATUS"
if [ "$STATUS" != "Accepted" ]; then
  log "FAIL step 3: notarization status='$STATUS' (expected Accepted)"
  log "Pull full log:  xcrun notarytool log <id> --keychain-profile $APPLE_NOTARY_PROFILE"
  exit 22
fi

# ---- 4. staple (best-effort on bare Mach-O) + 5. spctl assess ----
log "step 4: stapler staple (may warn for bare Mach-O — ticket lives on Apple CDN)"
xcrun stapler staple "$SEA_BINARY" >> "$DIST/notarize.log" 2>&1 || \
  log "  (stapler warned; bare Mach-O cannot embed ticket — verifying via spctl instead)"

log "step 5: spctl --assess"
if ! spctl --assess --type execute --verbose=4 "$SEA_BINARY" >> "$DIST/notarize.log" 2>&1; then
  log "FAIL step 5: spctl assess rejected the binary"
  exit 23
fi

cp "$SEA_BINARY" "$DIST/${BIN_BASENAME}.signed"
log "OK — signed+notarized binary at $DIST/${BIN_BASENAME}.signed"
exit 0
