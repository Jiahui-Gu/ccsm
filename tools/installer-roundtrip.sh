#!/usr/bin/env bash
# tools/installer-roundtrip.sh
#
# NON-GATING DRAFT for v0.3 — see spec ch12 §4.4:
#
#   "Mac and linux do NOT have a ship-gate (d) equivalent in v0.3."
#
#   "An installer-roundtrip.sh script may be drafted in parallel for
#    future use, but it is NOT a v0.3 ship-gate — the ship-gate set is
#    intentionally asymmetric across OSes."
#
# Status: SHELL only. The pkg/deb/rpm artifacts (chapter 10 §5.2 / §5.3)
# do not exist yet (#82 / #81 blocked). When they land, replace the
# `dry_run` body's stub install/uninstall with real `installer -pkg ...`
# (mac) or `dpkg -i / dpkg -r` / `rpm -i / rpm -e` (linux).
#
# Mirrors the contract of `tools/installer-roundtrip.ps1`:
#   - Loops both REMOVEUSERDATA=0 and REMOVEUSERDATA=1.
#     (On mac/linux the env var name is `CCSM_REMOVE_USER_DATA`, per
#      spec ch10 §5 step 4.)
#   - Snapshots fs (no registry on these OSes) before install + after
#     uninstall, diffs against `test/installer-residue-allowlist.txt`
#     plus the variant overlay for the keep-user-data run.
#   - Fail-closed on missing allowlist file.
#
# Usage:
#   tools/installer-roundtrip.sh --dry-run
#   tools/installer-roundtrip.sh --pkg <path-to-pkg-or-deb-or-rpm> [--variants 0,1]

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GLOBAL_ALLOWLIST="${REPO_ROOT}/test/installer-residue-allowlist.txt"
OVERLAY_ALLOWLIST="${REPO_ROOT}/test/installer-residue-allowlist.removeuserdata-0.txt"

DRY_RUN=0
PKG_PATH=""
VARIANTS="0,1"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)  DRY_RUN=1; shift ;;
    --pkg)      PKG_PATH="$2"; shift 2 ;;
    --variants) VARIANTS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ---------------------------------------------------------------------------
# FOREVER-STABLE: allowlist parser (mirror of Read-AllowlistFile in .ps1)
# ---------------------------------------------------------------------------

read_allowlist() {
  # Args: <path>. Prints one regex per line on stdout.
  # Blank + '#'-prefixed lines (after trim) skipped. Missing file = fatal.
  local path="$1"
  if [[ ! -f "$path" ]]; then
    echo "FATAL: allowlist file not found: $path" >&2
    return 1
  fi
  # POSIX-portable trim + filter.
  awk '{ sub(/^[[:space:]]+/,""); sub(/[[:space:]]+$/,""); if (length($0)==0) next; if (substr($0,1,1)=="#") next; print }' "$path"
}

is_allowed() {
  # Args: <entry> <allowlist-tmpfile>. Returns 0 if entry matches any pattern.
  local entry="$1" patfile="$2" pat
  while IFS= read -r pat; do
    [[ -z "$pat" ]] && continue
    if [[ "$entry" =~ $pat ]]; then return 0; fi
  done < "$patfile"
  return 1
}

build_combined_allowlist() {
  # Args: <variant 0|1> <out-file>
  local variant="$1" out="$2"
  : > "$out"
  read_allowlist "$GLOBAL_ALLOWLIST" >> "$out"
  if [[ "$variant" == "0" ]]; then
    read_allowlist "$OVERLAY_ALLOWLIST" >> "$out"
  fi
}

# ---------------------------------------------------------------------------
# DryRun: synthetic-fixture round-trip
# ---------------------------------------------------------------------------

dry_run() {
  local tmpdir
  tmpdir="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '$tmpdir'" EXIT

  local allow_r0="$tmpdir/allow.r0" allow_r1="$tmpdir/allow.r1"
  build_combined_allowlist 0 "$allow_r0"
  build_combined_allowlist 1 "$allow_r1"

  echo "[DryRun] global+overlay (variant=0) patterns: $(grep -c . "$allow_r0")"
  echo "[DryRun] global only    (variant=1) patterns: $(grep -c . "$allow_r1")"

  # Synthetic mix. Note: shell is unix-style paths; the global allowlist is
  # Windows-pathed because the v0.3 ship-gate is Windows-only. For the
  # mac/linux non-gating draft we exercise the parser only — full mac/linux
  # path patterns will be added when the .pkg / .deb / .rpm builds land
  # alongside this script being promoted out of "non-gating".
  local entries=(
    'C:\Windows\SoftwareDistribution\DataStore\Logs\edb01.log'
    'C:\Program Files\ccsm\ccsm-daemon.exe'
    'HKLM\SYSTEM\CurrentControlSet\Services\ccsm-daemon\ImagePath'
    'C:\ProgramData\ccsm\crash\dump.dmp'
  )

  local fail=0 e variant allow_file
  for variant in 0 1; do
    if [[ "$variant" == "0" ]]; then allow_file="$allow_r0"; else allow_file="$allow_r1"; fi
    echo "[DryRun] variant=$variant"
    for e in "${entries[@]}"; do
      if is_allowed "$e" "$allow_file"; then
        echo "  ALLOWED : $e"
      else
        echo "  RESIDUE : $e"
      fi
    done
  done

  echo "[DryRun] PASS — parser surface OK. (Real install/uninstall = TODO when #82/#81 land.)"
  return $fail
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  dry_run
  exit $?
fi

if [[ -z "$PKG_PATH" ]]; then
  echo "ERROR: --pkg <path> required (or --dry-run)" >&2
  exit 2
fi

echo "FATAL: real-install ship-gate is blocked on tasks #82 / #81 (pkg/deb/rpm artifacts)." >&2
echo "       Run with --dry-run to exercise the parser. Mac/linux is NON-GATING in v0.3" >&2
echo "       per spec ch12 §4.4 — this script is a draft for v0.4 promotion." >&2
exit 3
