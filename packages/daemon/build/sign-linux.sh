#!/usr/bin/env bash
# packages/daemon/build/sign-linux.sh
#
# Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
#       chapter 10 §3 (code signing) row "Linux".
#
# Task #82 (T7.3) — per-OS signing scaffolding (placeholder-safe).
#
# Per spec, Linux does NOT sign the bare ELF binary at the binary level
# (no `codesign` equivalent on Linux). Signing happens at the package level:
#
#   - .deb  -> debsigs --sign=origin -k <gpg-key-id> <pkg>.deb
#   - .rpm  -> rpm --addsign <pkg>.rpm   (requires ~/.rpmmacros %_gpg_name)
#   - bare binary -> gpg --detach-sign -u <key> -o ccsm-daemon.sig ccsm-daemon
#                    (optional; consumer is verify-signing.sh per ch10 §7)
#
# This script signs whatever artifact paths are passed in. The build-sea.sh
# pipeline produces only the bare ELF binary today; .deb / .rpm packages are
# produced by a downstream `fpm`-based packaging job (ch10 §5.3) — that job
# calls this script with the .deb / .rpm path it just produced.
#
# Placeholder-safe (project_v03_ship_intent): if GPG_SIGNING_KEY is unset,
# debsigs / rpm tooling is missing, or no signable artifact is found, the
# script logs a WARN and exits 0. Local dogfood `npm run build` MUST NOT
# fail when no signing key is configured.
#
# Env contract (forever-stable):
#   GPG_SIGNING_KEY     GPG key id (long form, e.g. 0xABCD1234...) used by
#                       debsigs / rpm --addsign / gpg --detach-sign. Must be
#                       imported into the host gpg keyring beforehand.
#   GPG_PASSPHRASE      optional; if set, exported as $GPG_TTY workaround
#                       hint and passed via --pinentry-mode loopback to gpg.
#                       In CI prefer a non-interactive key (no passphrase) or
#                       gpg-agent preset.
#   CCSM_SIGN_DRY_RUN   if "1", print the commands that WOULD run and exit
#                       0 without invoking debsigs / rpm / gpg.
#
# Inputs (positional, all optional):
#   $1   bare daemon binary       (default: <pkg>/dist/ccsm-daemon)
#   $2   .deb path                (default: skip)
#   $3   .rpm path                (default: skip)

set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_DIR="$(cd "$HERE/.." && pwd)"
DIST_DIR="$PKG_DIR/dist"

BINARY="${1:-$DIST_DIR/ccsm-daemon}"
DEB_PATH="${2:-}"
RPM_PATH="${3:-}"

DRY_RUN="${CCSM_SIGN_DRY_RUN:-0}"

log()  { echo "[sign-linux] $*"; }
warn() { echo "[sign-linux] WARN: $*" >&2; }

# ---- 0. placeholder-safe gate ----
if [[ -z "${GPG_SIGNING_KEY:-}" ]] && [[ "$DRY_RUN" != "1" ]]; then
  warn "GPG_SIGNING_KEY not set; skipping linux signing."
  warn "this is placeholder-safe behavior for dogfood builds."
  warn "see scripts/sign/README.md for the env-var contract."
  exit 0
fi

run_or_echo() {
  if [[ "$DRY_RUN" == "1" ]]; then
    echo "[sign-linux DRY-RUN]" "$@"
  else
    "$@"
  fi
}

KEY="${GPG_SIGNING_KEY:-PLACEHOLDER_KEY}"
GPG_OPTS=()
if [[ -n "${GPG_PASSPHRASE:-}" ]]; then
  GPG_OPTS+=(--batch --yes --pinentry-mode loopback --passphrase "$GPG_PASSPHRASE")
fi

did_anything=0

# ---- 1. detached-sig the bare binary (optional, ch10 §7 consumer) ----
if [[ -f "$BINARY" ]] || [[ "$DRY_RUN" == "1" ]]; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v gpg >/dev/null 2>&1; then
    warn "gpg not on PATH; skipping detached-sig for $BINARY."
  else
    log "gpg --detach-sign $BINARY"
    SIG_PATH="${BINARY}.sig"
    if [[ "$DRY_RUN" != "1" ]]; then
      rm -f "$SIG_PATH"
    fi
    run_or_echo gpg "${GPG_OPTS[@]}" --detach-sign --armor \
                    --local-user "$KEY" \
                    --output "$SIG_PATH" \
                    "$BINARY"
    did_anything=1
  fi
fi

# ---- 2. debsigs sign .deb ----
if [[ -n "$DEB_PATH" ]]; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v debsigs >/dev/null 2>&1; then
    warn "debsigs not on PATH; cannot sign $DEB_PATH (apt-get install debsigs)."
  elif [[ "$DRY_RUN" != "1" ]] && [[ ! -f "$DEB_PATH" ]]; then
    warn ".deb not found at $DEB_PATH; skipping."
  else
    log "debsigs --sign=origin $DEB_PATH"
    run_or_echo debsigs --sign=origin -k "$KEY" "$DEB_PATH"
    did_anything=1
  fi
fi

# ---- 3. rpm --addsign .rpm ----
if [[ -n "$RPM_PATH" ]]; then
  if [[ "$DRY_RUN" != "1" ]] && ! command -v rpm >/dev/null 2>&1; then
    warn "rpm not on PATH; cannot sign $RPM_PATH (yum/apt install rpm)."
  elif [[ "$DRY_RUN" != "1" ]] && [[ ! -f "$RPM_PATH" ]]; then
    warn ".rpm not found at $RPM_PATH; skipping."
  else
    # rpm --addsign reads %_gpg_name from ~/.rpmmacros. We set it inline via
    # --define so callers don't need to mutate global state.
    log "rpm --addsign $RPM_PATH"
    run_or_echo rpm --define "_gpg_name $KEY" --addsign "$RPM_PATH"
    did_anything=1
  fi
fi

if [[ "$did_anything" -eq 0 ]] && [[ "$DRY_RUN" != "1" ]]; then
  warn "no artifacts were signed (no binary, no .deb, no .rpm provided)."
fi

log "OK — linux signing pass complete."
