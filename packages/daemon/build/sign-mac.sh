#!/usr/bin/env bash
# packages/daemon/build/sign-mac.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §3 (code signing) + ch14 §1.13 (macOS notarization recipe).
#
# Task #82 (T7.3) — per-OS signing scaffolding (placeholder-safe).
# Reuses the recipe pinned by the T9.12 spike at
# tools/spike-harness/probes/macos-notarization-sea/notarize.sh and the
# forever-stable hardened-runtime entitlements at
# tools/spike-harness/entitlements-jit.plist (ch14 §1.B).
#
# Pipeline (per ch10 §3):
#   For each artifact in {ccsm-daemon Mach-O, every native/*.node}:
#     1. codesign --options runtime --entitlements <jit-plist>
#                 --identifier <bundle-id> --timestamp --force
#                 --sign "$APPLE_SIGNING_IDENTITY"
#   Then for the daemon binary only:
#     2. ditto -c -k --keepParent <binary> <submit.zip>
#     3. xcrun notarytool submit <submit.zip>
#                 --keychain-profile "$APPLE_NOTARY_PROFILE" --wait
#                 --output-format json
#        Assert .status == "Accepted".
#     4. xcrun stapler staple <binary> || true   (bare Mach-O ticket lives on
#        Apple CDN; spctl --assess confirms Gatekeeper acceptance)
#     5. spctl --assess --type execute --verbose=4 <binary>
#
# Placeholder-safe (project_v03_ship_intent): if any required env var is
# missing OR the host is not macOS OR Apple toolchain is absent, the script
# logs a WARN line and exits 0. It MUST NOT hard-fail dogfood builds run
# locally without certs. CI release jobs (T0.9 / T7.x) are responsible for
# providing the env and treating missing certs as a hard failure at the
# release-job level.
#
# Env contract (forever-stable per ch14 §1.B):
#   APPLE_TEAM_ID            10-char Apple Developer team identifier.
#   APPLE_SIGNING_IDENTITY   exact `security find-identity` line, e.g.
#                            "Developer ID Application: Acme Co (XXXXXXXXXX)".
#   APPLE_NOTARY_PROFILE     `xcrun notarytool store-credentials` profile
#                            holding Apple ID + app-specific password.
#   CCSM_SIGN_DRY_RUN        if "1", print the codesign / notarytool
#                            invocations that WOULD run and exit 0 without
#                            touching any artifact (for unit tests + local
#                            verification).
#
# Inputs (positional):
#   $1   absolute path to the daemon binary (default: <pkg>/dist/ccsm-daemon)
#   $2   absolute path to the native/ dir   (default: <pkg>/dist/native)
#
# Out of scope (per task brief):
#   - .pkg / .app installer signing (lives in T7.4 macOS pkg job, downstream).
#   - The verify-signing.sh consumer script (T7.9 / task #80).
#   - CI workflow wiring (T0.9 / task #15; touching ci.yml is mutex-blocked).

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
REPO_ROOT="$(cd "$PKG_DIR/../.." && pwd)"
DIST_DIR="$PKG_DIR/dist"

BINARY="${1:-$DIST_DIR/ccsm-daemon}"
NATIVE_DIR="${2:-$DIST_DIR/native}"

ENTITLEMENTS="$REPO_ROOT/tools/spike-harness/entitlements-jit.plist"
INFO_PLIST="$REPO_ROOT/tools/spike-harness/probes/macos-notarization-sea/Info.plist"

DRY_RUN="${CCSM_SIGN_DRY_RUN:-0}"

log()  { echo "[sign-mac] $*"; }
warn() { echo "[sign-mac] WARN: $*" >&2; }

# ---- 0. placeholder-safe gate ----
if [[ "$(uname -s)" != "Darwin" ]] && [[ "$DRY_RUN" != "1" ]]; then
  warn "non-darwin host ($(uname -s)); macOS signing skipped."
  warn "this is expected for local cross-platform dogfood builds."
  exit 0
fi

MISSING=()
[[ -n "${APPLE_TEAM_ID:-}" ]]          || MISSING+=("APPLE_TEAM_ID")
[[ -n "${APPLE_SIGNING_IDENTITY:-}" ]] || MISSING+=("APPLE_SIGNING_IDENTITY")
[[ -n "${APPLE_NOTARY_PROFILE:-}" ]]   || MISSING+=("APPLE_NOTARY_PROFILE")

if [[ ${#MISSING[@]} -gt 0 ]] && [[ "$DRY_RUN" != "1" ]]; then
  warn "missing required env: ${MISSING[*]}"
  warn "skipping signing — this is placeholder-safe behavior for dogfood builds."
  warn "see scripts/sign/README.md for the env-var contract."
  exit 0
fi

if [[ "$DRY_RUN" != "1" ]]; then
  for tool in codesign xcrun ditto spctl; do
    command -v "$tool" >/dev/null 2>&1 || {
      warn "missing tool: $tool — skipping signing."
      exit 0
    }
  done
  xcrun --find notarytool >/dev/null 2>&1 || {
    warn "xcrun notarytool not found (need Xcode 13+) — skipping."
    exit 0
  }
  xcrun --find stapler >/dev/null 2>&1 || {
    warn "xcrun stapler not found — skipping."
    exit 0
  }
  [[ -f "$ENTITLEMENTS" ]] || { warn "entitlements missing: $ENTITLEMENTS — skipping."; exit 0; }
  [[ -f "$INFO_PLIST" ]]   || { warn "Info.plist missing: $INFO_PLIST — skipping."; exit 0; }
  [[ -f "$BINARY" ]]       || { warn "daemon binary missing: $BINARY — skipping."; exit 0; }
fi

# Run-mode (env satisfied OR dry-run). Build the artifact list:
#   1. the daemon Mach-O
#   2. every *.node under native/
ARTIFACTS=("$BINARY")
if [[ -d "$NATIVE_DIR" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" ]] && ARTIFACTS+=("$f")
  done < <(find "$NATIVE_DIR" -type f -name '*.node' 2>/dev/null || true)
fi

# Read bundle id from the canonical Info.plist (fallback to default in dry-run
# when PlistBuddy may not exist on non-mac hosts).
if [[ "$DRY_RUN" == "1" ]] || ! command -v /usr/libexec/PlistBuddy >/dev/null 2>&1; then
  BUNDLE_ID="com.ccsm.daemon"
else
  BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "$INFO_PLIST")"
fi

run_or_echo() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[sign-mac DRY-RUN]" "$@"
  else
    "$@"
  fi
}

# ---- 1. codesign each artifact (binary + every .node) ----
log "codesign ${#ARTIFACTS[@]} artifact(s) with hardened runtime + JIT entitlements"
for art in "${ARTIFACTS[@]}"; do
  log "  codesign $art"
  run_or_echo codesign \
    --sign "${APPLE_SIGNING_IDENTITY:-PLACEHOLDER_IDENTITY}" \
    --options runtime \
    --entitlements "$ENTITLEMENTS" \
    --identifier "$BUNDLE_ID" \
    --timestamp \
    --force \
    "$art"
done

# Verify the daemon's signature locally (cheap fail-fast). Skipped in dry-run.
if [[ "$DRY_RUN" != "1" ]]; then
  codesign --verify --deep --strict --verbose=2 "$BINARY"
fi

# ---- 2. ditto -> submit.zip (daemon binary only — .node files inherit
#         notarization status from being signed in step 1; Apple notarizes
#         the bundle / archive submission, not each member) ----
SUBMIT_ZIP="$DIST_DIR/submit.zip"
log "ditto -c -k --keepParent $BINARY $SUBMIT_ZIP"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[sign-mac DRY-RUN] ditto -c -k --keepParent $BINARY $SUBMIT_ZIP"
else
  rm -f "$SUBMIT_ZIP"
  ditto -c -k --keepParent "$BINARY" "$SUBMIT_ZIP"
fi

# ---- 3. notarytool submit --wait ----
SUBMISSION_JSON="$DIST_DIR/notarytool-submission.json"
log "xcrun notarytool submit --wait (profile=${APPLE_NOTARY_PROFILE:-PLACEHOLDER})"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[sign-mac DRY-RUN] xcrun notarytool submit $SUBMIT_ZIP --keychain-profile $APPLE_NOTARY_PROFILE --wait --output-format json > $SUBMISSION_JSON"
else
  xcrun notarytool submit "$SUBMIT_ZIP" \
        --keychain-profile "$APPLE_NOTARY_PROFILE" \
        --wait \
        --output-format json \
        > "$SUBMISSION_JSON"
  STATUS="$(/usr/bin/python3 -c "import json,sys;print(json.load(open(sys.argv[1])).get('status',''))" "$SUBMISSION_JSON")"
  log "notarytool status=$STATUS"
  if [[ "$STATUS" != "Accepted" ]]; then
    echo "[sign-mac] FAIL: notarization status='$STATUS' (expected Accepted)" >&2
    echo "[sign-mac] pull log: xcrun notarytool log <id> --keychain-profile $APPLE_NOTARY_PROFILE" >&2
    exit 22
  fi
fi

# ---- 4. staple (best-effort on bare Mach-O) ----
log "xcrun stapler staple $BINARY (best-effort)"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[sign-mac DRY-RUN] xcrun stapler staple $BINARY"
else
  xcrun stapler staple "$BINARY" || \
    log "  (stapler warned — bare Mach-O ticket served from Apple CDN; spctl will assess)"
fi

# ---- 5. spctl assess ----
log "spctl --assess --type execute $BINARY"
if [[ "$DRY_RUN" == "1" ]]; then
  echo "[sign-mac DRY-RUN] spctl --assess --type execute --verbose=4 $BINARY"
else
  spctl --assess --type execute --verbose=4 "$BINARY"
fi

log "OK — signed + notarized: $BINARY (+ ${#ARTIFACTS[@]} total artifacts codesigned)"
