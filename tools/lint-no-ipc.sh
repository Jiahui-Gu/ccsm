#!/usr/bin/env bash
#
# tools/lint-no-ipc.sh — ship-gate (a) for v0.3 Electron→daemon split.
#
# Greps electron/ and src/ (and packages/electron/src/ once populated) for
# forbidden IPC / preload-injection patterns:
#   - ipcMain
#   - ipcRenderer
#   - contextBridge
#   - additionalArguments
#   - webContents.send
#
# Comment lines (//, *, #) are skipped — comments mentioning forbidden symbols
# (e.g. "// the v0.2 ipcMain handler is gone, see Wave 0c") do not constitute
# IPC use. This is a deliberate carve-out, NOT an allowlist expansion: real
# code lines using these symbols still fail.
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

# Wave 0f (#214): broaden scope to include both the legacy `electron/` tree
# (Electron main + ptyHost + notify sinks at repo root) and the renderer
# `src/` tree. Both must be IPC-free for the v0.3 daemon split. The future
# `packages/electron/src/` location is also scanned for forward compatibility
# once the migration completes.
SCAN_DIRS=(
  "${REPO_ROOT}/electron"
  "${REPO_ROOT}/src"
  "${REPO_ROOT}/packages/electron/src"
)
ALLOWLIST_FILE="${REPO_ROOT}/tools/.no-ipc-allowlist"

# Forbidden patterns — extended-regex alternation. Order matches §5h.1.
FORBIDDEN='ipcMain|ipcRenderer|contextBridge|additionalArguments|webContents\.send'

# Comment-line prefix regex: matches lines whose first non-whitespace char is
# `//` (TS/JS line comment), `*` (TS/JS block-comment continuation or JSDoc),
# or `#` (defensive — embedded shell). Stripping these BEFORE the forbidden
# match means a comment mentioning `ipcMain` doesn't trip the gate, while a
# real `ipcMain.on(...)` line still does.
COMMENT_PREFIX='^[[:space:]]*(//|\*|#)'

# Filter out scan dirs that don't exist.
existing_dirs=()
for d in "${SCAN_DIRS[@]}"; do
  if [ -d "${d}" ]; then
    existing_dirs+=("${d}")
  fi
done

if [ "${#existing_dirs[@]}" -eq 0 ]; then
  echo "PASS: none of the scan dirs (${SCAN_DIRS[*]}) exist"
  exit 0
fi

# Build allowlist set: each line that is non-blank and not a comment is one
# repo-relative path to skip.
allowlist_paths=""
if [ -f "${ALLOWLIST_FILE}" ]; then
  allowlist_paths="$(
    tr -d '\r' < "${ALLOWLIST_FILE}" \
      | grep -v '^[[:space:]]*$' \
      | grep -v '^[[:space:]]*#' \
      || true
  )"
fi

# Enumerate candidate source files.
candidate_files="$(
  find "${existing_dirs[@]}" \
    \( -type d \( -name node_modules -o -name dist -o -name build \) -prune \) -o \
    -type f \( -name '*.ts' -o -name '*.tsx' -o -name '*.js' -o -name '*.jsx' \) -print
)"

if [ -z "${candidate_files}" ]; then
  echo "PASS: no .ts/.tsx/.js/.jsx files under ${existing_dirs[*]}"
  exit 0
fi

# Filter out allowlisted files (suffix match against repo-relative path).
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

# Run grep across the filtered set, then strip comment-only matches. grep -Hn
# emits `<file>:<lineno>:<linecontent>`. We extract the content with sed
# (drop everything up to and including the lineno colon) and skip if it
# matches the comment prefix.
raw_hits="$(
  printf '%s\n' "${filtered_files}" \
    | xargs grep -EHn -- "${FORBIDDEN}" 2>/dev/null \
    || true
)"

hits=""
if [ -n "${raw_hits}" ]; then
  hits="$(
    printf '%s\n' "${raw_hits}" \
      | while IFS= read -r line; do
          [ -z "${line}" ] && continue
          content="$(printf '%s' "${line}" | sed -E 's/^.*:[0-9]+://')"
          if ! printf '%s' "${content}" | grep -Eq "${COMMENT_PREFIX}"; then
            printf '%s\n' "${line}"
          fi
        done
  )"
fi

if [ -n "${hits}" ]; then
  echo "FAIL: forbidden IPC / preload-injection patterns found:"
  echo "${hits}"
  echo ""
  echo "See chapter 08 §5h.1 / chapter 12 §4.1. Allowlist is FROZEN per chapter 15 §3 #29."
  exit 1
fi

echo "PASS: zero IPC residue under ${existing_dirs[*]}"
exit 0
