#!/usr/bin/env bash
#
# tools/lint-no-ipc.sh — ship-gate (a) for v0.3 Electron→daemon split.
#
# Greps packages/electron/src/ for forbidden IPC / preload-injection patterns:
#   - ipcMain
#   - ipcRenderer
#   - contextBridge
#   - additionalArguments
#   - webContents.send
#
# Files listed in tools/.no-ipc-allowlist are exempt (one path per line; lines
# starting with '#' and blank lines are ignored).
#
# Exit non-zero on any unallowed match. Output format per finding:
#   <file>:<line>:<matched-line>
#
# Cross-platform: POSIX-portable bash + grep + find. No bash globstar; no
# GNU-specific find flags. Verified on linux, macOS, and Git Bash on Windows.
#
# SPEC REFERENCES
#   - chapter 08 §5h.1  — canonical lint:no-ipc spec (forbidden symbol set)
#   - chapter 12 §4.1   — ship-gate (a) implementation (this script)
#   - chapter 15 §3 #11 — bypassing this gate is a forbidden pattern
#   - chapter 15 §3 #29 — tools/.no-ipc-allowlist contents are forever-stable;
#                          additions require R4 sign-off + chapter-15 audit row
#
# FOREVER-STABLE per chapter 15 §3 #11/#29: this script's behaviour and the
# allowlist contents are locked at v0.3 ship. Future PRs that change either
# without an audit-table-revalidate override (T10.11) will be rejected.

set -euo pipefail

# Resolve repo root from this script's location so the script works regardless
# of cwd (CI / pre-commit / manual invocation).
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

SRC_DIR="${REPO_ROOT}/packages/electron/src"
ALLOWLIST_FILE="${REPO_ROOT}/tools/.no-ipc-allowlist"

# Forbidden patterns — extended-regex alternation. Order matches §5h.1.
FORBIDDEN='ipcMain|ipcRenderer|contextBridge|additionalArguments|webContents\.send'

# Empty / missing source dir → ship-gate trivially passes (e.g., before the
# Electron migration PR lands packages/electron/src is empty).
if [ ! -d "${SRC_DIR}" ]; then
  echo "PASS: ${SRC_DIR} does not exist (no Electron sources to lint)"
  exit 0
fi

# Build allowlist set: each line that is non-blank and not a comment is one
# repo-relative path to skip. Stored as newline-joined text for grep -vF -f.
allowlist_paths=""
if [ -f "${ALLOWLIST_FILE}" ]; then
  # POSIX-portable: strip CR (Windows line endings), drop blanks, drop comments.
  allowlist_paths="$(
    tr -d '\r' < "${ALLOWLIST_FILE}" \
      | grep -v '^[[:space:]]*$' \
      | grep -v '^[[:space:]]*#' \
      || true
  )"
fi

# Enumerate candidate source files via `find` (no globstar; explicit -type f).
# Exclude node_modules / dist defensively in case they ever appear under src/.
candidate_files="$(
  find "${SRC_DIR}" \
    \( -type d \( -name node_modules -o -name dist \) -prune \) -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) -print
)"

# Empty source tree → pass.
if [ -z "${candidate_files}" ]; then
  echo "PASS: no .ts/.tsx/.js/.jsx files under ${SRC_DIR}"
  exit 0
fi

# Filter out allowlisted files. Allowlist entries are repo-relative paths;
# match by suffix against each absolute candidate path.
filtered_files=""
while IFS= read -r abs_path; do
  [ -z "${abs_path}" ] && continue
  rel_path="${abs_path#${REPO_ROOT}/}"
  skip=0
  if [ -n "${allowlist_paths}" ]; then
    while IFS= read -r allow_entry; do
      [ -z "${allow_entry}" ] && continue
      if [ "${rel_path}" = "${allow_entry}" ]; then
        skip=1
        break
      fi
    done <<EOF
${allowlist_paths}
EOF
  fi
  if [ "${skip}" -eq 0 ]; then
    if [ -z "${filtered_files}" ]; then
      filtered_files="${abs_path}"
    else
      filtered_files="${filtered_files}
${abs_path}"
  fi
  fi
done <<EOF
${candidate_files}
EOF

if [ -z "${filtered_files}" ]; then
  echo "PASS: every candidate file is on the allowlist"
  exit 0
fi

# Run grep across the filtered set. -E extended regex, -n line numbers,
# -H always print filename (works even with one input file). `|| true` so we
# can inspect a non-zero "no match" without tripping `set -e`.
hits="$(
  printf '%s\n' "${filtered_files}" \
    | xargs grep -EHn -- "${FORBIDDEN}" 2>/dev/null \
    || true
)"

if [ -n "${hits}" ]; then
  echo "FAIL: forbidden IPC / preload-injection patterns found:"
  # Emit <file>:<line>:<match> as grep -Hn already produces.
  echo "${hits}"
  echo ""
  echo "See chapter 08 §5h.1 / chapter 12 §4.1. Allowlist is FROZEN per chapter 15 §3 #29."
  exit 1
fi

echo "PASS: zero IPC residue under ${SRC_DIR}"
exit 0
