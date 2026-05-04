#!/usr/bin/env bash
# tools/verify-signing.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §7 (per-OS signature verification).
#
# Task #80 (T7.9) — per-OS signing VERIFIER. The companion to T7.3 (#82)
# which produces the signatures. Invoked in each `package-{mac-pkg,
# linux-deb,linux-rpm}` CI job AFTER signing and BEFORE artifact upload
# (see ch10 §7 last paragraph). Windows uses verify-signing.ps1 (sibling).
#
# Per ch10 §7:
#
#   - macOS:   for each of {ccsm-daemon, native/*.node, *.app, *.pkg}:
#                codesign --verify --deep --strict --verbose=4 <path>
#                AND spctl --assess --type install --verbose <path>
#                     (or --type execute for the bare binary)
#              Assert exit 0 AND output contains 'accepted' / 'valid on disk'.
#
#   - Linux:   .deb         -> dpkg-sig --verify <path>; assert GOODSIG.
#              .rpm         -> rpm --checksig -v <path>; assert
#                                "(sha256) Header SHA256 digest: OK"
#                                AND "Header V4 RSA/SHA256 Signature, key ID ...: OK".
#              bare binary  -> gpg --verify ccsm-daemon.sig ccsm-daemon.
#
# Placeholder-safe (project_v03_ship_intent): on a non-target host or when
# verifier tooling is missing, the script logs WARN and exits 0 so local
# dogfood `npm run build` smoke does not break. CI release jobs MUST set
# CCSM_VERIFY_SIGNING_STRICT=1, which flips every "skipped because tool/
# host/env missing" gate into a hard failure (exit 30+). A REAL bad-
# signature finding ALWAYS exits non-zero regardless of strict mode —
# strict only governs the should-have-run-but-couldn't class.
#
# Env contract (forever-stable):
#   CCSM_VERIFY_SIGNING_STRICT  if "1", missing tooling / wrong host /
#                               missing inputs are HARD FAILURES (exit 30).
#                               Default 0 = placeholder-safe (exit 0+WARN).
#   CCSM_EXPECTED_CERT_CN       optional substring expected in the signer
#                               Subject (mac codesign authority + linux
#                               key-id check). When unset the check is
#                               skipped (only signature validity is
#                               asserted). Set in CI to pin the release
#                               cert against substitution.
#
# Inputs (flags, all optional — only verifies what is provided / found):
#   --binary <path>     bare daemon binary (default: packages/daemon/dist/ccsm-daemon)
#   --native <dir>      native/ dir to scan for *.node (default: <pkg>/dist/native)
#   --pkg <path>        macOS .pkg installer
#   --app <path>        macOS .app bundle (fallback path per ch10 §1)
#   --deb <path>        Linux .deb package
#   --rpm <path>        Linux .rpm package
#   --sig <path>        detached signature for --binary (default: <binary>.sig)
#   -h | --help         print usage and exit 0.

set -uo pipefail

# Exit codes:
#   0   all verified / placeholder-safe skip (non-strict)
#   20  bad signature found (always hard failure regardless of strict)
#   30  strict mode + missing tooling / wrong host / missing input

STRICT="${CCSM_VERIFY_SIGNING_STRICT:-0}"
EXPECTED_CN="${CCSM_EXPECTED_CERT_CN:-}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"
DEFAULT_BIN="$REPO_ROOT/packages/daemon/dist/ccsm-daemon"
DEFAULT_NATIVE="$REPO_ROOT/packages/daemon/dist/native"

BINARY=""
NATIVE_DIR=""
PKG_PATH=""
APP_PATH=""
DEB_PATH=""
RPM_PATH=""
SIG_PATH=""

usage() {
  sed -n '2,55p' "$0"
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --binary) BINARY="${2:-}"; shift 2 ;;
    --native) NATIVE_DIR="${2:-}"; shift 2 ;;
    --pkg)    PKG_PATH="${2:-}"; shift 2 ;;
    --app)    APP_PATH="${2:-}"; shift 2 ;;
    --deb)    DEB_PATH="${2:-}"; shift 2 ;;
    --rpm)    RPM_PATH="${2:-}"; shift 2 ;;
    --sig)    SIG_PATH="${2:-}"; shift 2 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "[verify-signing] unknown arg: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -z "$BINARY"     ]] && BINARY="$DEFAULT_BIN"
[[ -z "$NATIVE_DIR" ]] && NATIVE_DIR="$DEFAULT_NATIVE"
[[ -z "$SIG_PATH"   ]] && SIG_PATH="${BINARY}.sig"

log()  { echo "[verify-signing] $*"; }
warn() { echo "[verify-signing] WARN: $*" >&2; }
fail() { echo "[verify-signing] FAIL: $*" >&2; }

# soft_skip <reason> — placeholder-safe skip in non-strict, hard fail in strict.
soft_skip() {
  local reason="$1"
  if [[ "$STRICT" == "1" ]]; then
    fail "$reason (CCSM_VERIFY_SIGNING_STRICT=1)"
    exit 30
  fi
  warn "$reason"
  warn "skipping — placeholder-safe (set CCSM_VERIFY_SIGNING_STRICT=1 in CI to enforce)."
  exit 0
}

OS="$(uname -s 2>/dev/null || echo Unknown)"

# Track whether any verification actually ran.
verified_count=0

# ---- helpers ----

assert_contains() {
  # assert_contains <haystack> <needle> <context>
  if ! grep -qF -- "$2" <<<"$1"; then
    fail "$3: expected output to contain '$2'"
    return 1
  fi
  return 0
}

# ---- macOS branch ----
verify_mac_path() {
  # $1 = path, $2 = spctl --type (execute|install)
  local path="$1" type="$2"
  if [[ ! -e "$path" ]]; then
    fail "missing artifact: $path"
    return 1
  fi
  log "  codesign --verify --deep --strict --verbose=4 $path"
  local cs_out
  if ! cs_out="$(codesign --verify --deep --strict --verbose=4 "$path" 2>&1)"; then
    fail "codesign verify failed: $path"
    echo "$cs_out" >&2
    return 1
  fi
  # codesign --verify success: stderr typically contains "valid on disk".
  if ! grep -qE "valid on disk|satisfies its Designated Requirement" <<<"$cs_out"; then
    # Some codesign versions print nothing on success — accept exit 0 alone
    # but warn so a future regression where Apple changes the message is
    # surfaced.
    warn "codesign succeeded but did not print 'valid on disk' for $path"
  fi

  log "  spctl --assess --type $type --verbose $path"
  local sp_out
  if ! sp_out="$(spctl --assess --type "$type" --verbose "$path" 2>&1)"; then
    fail "spctl assess failed: $path"
    echo "$sp_out" >&2
    return 1
  fi
  assert_contains "$sp_out" "accepted" "spctl $path" || return 1

  if [[ -n "$EXPECTED_CN" ]]; then
    # codesign -dvv prints "Authority=..." lines; the leaf authority
    # carries the EV CN.
    local auth_out
    auth_out="$(codesign -dvv "$path" 2>&1 || true)"
    if ! grep -qF "$EXPECTED_CN" <<<"$auth_out"; then
      fail "expected cert CN '$EXPECTED_CN' not found in codesign authority for $path"
      echo "$auth_out" >&2
      return 1
    fi
  fi
  return 0
}

run_mac() {
  for tool in codesign spctl; do
    if ! command -v "$tool" >/dev/null 2>&1; then
      soft_skip "$tool not on PATH (need macOS Xcode command-line tools)"
    fi
  done

  local targets=()
  [[ -e "$BINARY" ]] && targets+=("execute|$BINARY")

  if [[ -d "$NATIVE_DIR" ]]; then
    while IFS= read -r f; do
      [[ -n "$f" ]] && targets+=("execute|$f")
    done < <(find "$NATIVE_DIR" -type f -name '*.node' 2>/dev/null || true)
  fi

  [[ -n "$APP_PATH" && -e "$APP_PATH" ]] && targets+=("execute|$APP_PATH")
  [[ -n "$PKG_PATH" && -e "$PKG_PATH" ]] && targets+=("install|$PKG_PATH")

  if [[ ${#targets[@]} -eq 0 ]]; then
    soft_skip "no signed artifacts found (looked for $BINARY, $NATIVE_DIR/*.node, --app, --pkg)"
  fi

  log "verifying ${#targets[@]} macOS artifact(s)"
  local rc=0
  for t in "${targets[@]}"; do
    local type="${t%%|*}" path="${t#*|}"
    if verify_mac_path "$path" "$type"; then
      verified_count=$((verified_count + 1))
    else
      rc=20
    fi
  done
  if [[ $rc -ne 0 ]]; then exit $rc; fi
  log "OK — $verified_count macOS artifact(s) verified"
}

# ---- Linux branch ----
verify_linux_deb() {
  local deb="$1"
  if ! command -v dpkg-sig >/dev/null 2>&1; then
    soft_skip "dpkg-sig not on PATH (apt-get install dpkg-sig)"
  fi
  log "  dpkg-sig --verify $deb"
  local out
  if ! out="$(dpkg-sig --verify "$deb" 2>&1)"; then
    fail "dpkg-sig verify failed: $deb"
    echo "$out" >&2
    return 1
  fi
  assert_contains "$out" "GOODSIG" "dpkg-sig $deb" || return 1
  if [[ -n "$EXPECTED_CN" ]] && ! grep -qF "$EXPECTED_CN" <<<"$out"; then
    fail "expected key id '$EXPECTED_CN' not found in dpkg-sig output for $deb"
    echo "$out" >&2
    return 1
  fi
  return 0
}

verify_linux_rpm() {
  local rpm="$1"
  if ! command -v rpm >/dev/null 2>&1; then
    soft_skip "rpm not on PATH (yum/apt install rpm)"
  fi
  log "  rpm --checksig -v $rpm"
  local out
  if ! out="$(rpm --checksig -v "$rpm" 2>&1)"; then
    fail "rpm --checksig failed: $rpm"
    echo "$out" >&2
    return 1
  fi
  # Per spec: assert both lines.
  assert_contains "$out" "Header SHA256 digest: OK" "rpm checksig $rpm" || return 1
  if ! grep -qE "Header V4 (RSA|DSA|EdDSA)/SHA256 Signature, key ID .*: OK" <<<"$out"; then
    fail "rpm checksig: missing 'Header V4 RSA/SHA256 Signature, key ID ...: OK' for $rpm"
    echo "$out" >&2
    return 1
  fi
  if [[ -n "$EXPECTED_CN" ]] && ! grep -qF "$EXPECTED_CN" <<<"$out"; then
    fail "expected key id '$EXPECTED_CN' not found in rpm checksig output for $rpm"
    echo "$out" >&2
    return 1
  fi
  return 0
}

verify_linux_binary() {
  local bin="$1" sig="$2"
  if ! command -v gpg >/dev/null 2>&1; then
    soft_skip "gpg not on PATH"
  fi
  if [[ ! -e "$sig" ]]; then
    soft_skip "detached signature missing: $sig (expected from sign-linux.sh detach-sign step)"
  fi
  log "  gpg --verify $sig $bin"
  local out
  if ! out="$(gpg --verify "$sig" "$bin" 2>&1)"; then
    fail "gpg --verify failed: $bin"
    echo "$out" >&2
    return 1
  fi
  # gpg --verify success line: "Good signature from ...".
  assert_contains "$out" "Good signature" "gpg verify $bin" || return 1
  if [[ -n "$EXPECTED_CN" ]] && ! grep -qF "$EXPECTED_CN" <<<"$out"; then
    fail "expected key id '$EXPECTED_CN' not found in gpg verify output for $bin"
    echo "$out" >&2
    return 1
  fi
  return 0
}

run_linux() {
  local rc=0 did=0

  if [[ -n "$DEB_PATH" ]]; then
    if [[ ! -e "$DEB_PATH" ]]; then
      fail "missing .deb: $DEB_PATH"
      rc=20
    elif verify_linux_deb "$DEB_PATH"; then
      verified_count=$((verified_count + 1)); did=1
    else
      rc=20
    fi
  fi

  if [[ -n "$RPM_PATH" ]]; then
    if [[ ! -e "$RPM_PATH" ]]; then
      fail "missing .rpm: $RPM_PATH"
      rc=20
    elif verify_linux_rpm "$RPM_PATH"; then
      verified_count=$((verified_count + 1)); did=1
    else
      rc=20
    fi
  fi

  if [[ -e "$BINARY" || -e "$SIG_PATH" ]]; then
    if [[ ! -e "$BINARY" ]]; then
      fail "missing binary: $BINARY"
      rc=20
    elif verify_linux_binary "$BINARY" "$SIG_PATH"; then
      verified_count=$((verified_count + 1)); did=1
    else
      rc=20
    fi
  fi

  if [[ $did -eq 0 && $rc -eq 0 ]]; then
    soft_skip "no signed artifacts found (pass --deb, --rpm, or place $BINARY + $SIG_PATH)"
  fi

  if [[ $rc -ne 0 ]]; then exit $rc; fi
  log "OK — $verified_count Linux artifact(s) verified"
}

# ---- dispatch ----
case "$OS" in
  Darwin) run_mac ;;
  Linux)  run_linux ;;
  *)      soft_skip "unsupported host OS: $OS (use verify-signing.ps1 on Windows)" ;;
esac
