#!/usr/bin/env bash
#
# tools/lint-no-worker-threads.sh — regression gate for pty-host worker_threads.
#
# Enforces ch15 §3 #25: no worker_threads in pty-host.
#
# pivot pty per-session 边界永远走 child_process.fork (永久边界)。回到
# worker_threads.Worker 是 ch15 §3 #25 明令禁止的 forbidden pattern, 因为
# Worker 跟主进程共享 V8 isolate 边界过浅, native pty 崩会带塌整个 daemon。
#
# Greps the pty-host source tree for forbidden references:
#   - literal `worker_threads`
#   - `from 'worker_threads'` / `from "worker_threads"`
#   - `require('worker_threads')` / `require("worker_threads")`
#   - `new Worker(`
#
# Comment lines (//, *, #) are skipped — comments mentioning forbidden symbols
# (e.g. "// previously used worker_threads, see ch15 §3 #25") do not constitute
# Worker use. Mirrors the carve-out in tools/lint-no-ipc.sh.
#
# Exit non-zero on any match. Output format per finding:
#   <file>:<line>:<matched-line>
#
# Cross-platform: POSIX-portable bash + grep + find. No bash globstar; no
# GNU-specific find flags. Verified on Git Bash on Windows.
#
# SPEC REFERENCES
#   - chapter 15 §3 #25 — pty-host worker_threads forbidden pattern

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Both legacy and current pty-host locations. Spec calls out
# packages/daemon/src/pty-host/ (current) and apps/daemon/src/pty-host/
# (forward-compat for any future relocation).
SCAN_DIRS=(
  "${REPO_ROOT}/packages/daemon/src/pty-host"
  "${REPO_ROOT}/apps/daemon/src/pty-host"
)

# Forbidden patterns — extended-regex alternation.
#   - worker_threads               — module name (catches import 'worker_threads',
#                                     require('worker_threads'), and any string ref)
#   - new[[:space:]]+Worker\(      — instantiation of a Worker
FORBIDDEN='worker_threads|new[[:space:]]+Worker\('

# Comment-line prefix regex — same shape as lint-no-ipc.sh.
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

# Run grep across the candidate set, then strip comment-only matches.
raw_hits="$(
  printf '%s\n' "${candidate_files}" \
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
  echo "FAIL: forbidden worker_threads / Worker references found in pty-host:"
  echo "${hits}"
  echo ""
  echo "See chapter 15 §3 #25. pty-host per-session boundary must be child_process.fork, never worker_threads.Worker."
  exit 1
fi

echo "PASS: zero worker_threads residue under ${existing_dirs[*]}"
exit 0
