#!/usr/bin/env bash
#
# tools/release-candidate.sh — v0.3 ship-gate orchestrator (T8.15a).
#
# Spec: ch13 §2 phase 11. Drives the four release-candidate gates in
# strict order and, only if all four pass, emits a `git tag v0.3.0 <SHA>`
# suggestion for the user to run by hand.
#
# Gate matrix for v0.3 (see Task #414):
#   gate-a (IPC residue)        — REAL  (delegates to lint:no-ipc, T8.1).
#   gate-b (SIGKILL + Snapshot) — REAL  (runs sigkill-reattach + snapshot
#                                        codec specs, T8.3 / T8.5).
#   gate-c (pty-soak 1h)        — PLACEHOLDER (T8.4 not yet shipped, see #415).
#   gate-d (installer roundtrip)— PLACEHOLDER (T8.6 followup, see #415).
#
# Placeholders WARN + exit 0 on purpose: v0.3 ship plan is "4 dogfood
# items + minisign as the only hard blocker"; pty-soak and installer
# roundtrip are v0.4 concerns. Anything stricter would gate v0.3 on
# infrastructure that does not exist yet.
#
# Exit codes:
#   0  — all gates green, tag suggestion printed.
#   1  — a real gate (a or b) failed; no tag suggestion.
#   2  — internal driver error (missing helper script, bad cwd, etc.).
#
# Usage:
#   bash tools/release-candidate.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
LIB_DIR="${SCRIPT_DIR}/release-candidate/lib"

# Allow tests to substitute a fake lib dir to mock individual gates.
LIB_DIR="${CCSM_RC_LIB_DIR:-${LIB_DIR}}"

cd "${REPO_ROOT}"

if [[ ! -d "${LIB_DIR}" ]]; then
  echo "release-candidate: helper dir missing: ${LIB_DIR}" >&2
  exit 2
fi

GATES=(
  "gate-a:IPC residue (lint:no-ipc)"
  "gate-b:SIGKILL reattach + SnapshotV1"
  "gate-c:pty-soak 1h"
  "gate-d:installer roundtrip"
)

echo "=============================================="
echo " release-candidate.sh — v0.3 ship-gate driver"
echo " repo: ${REPO_ROOT}"
echo " sha:  $(git rev-parse HEAD 2>/dev/null || echo '<no git>')"
echo "=============================================="

for entry in "${GATES[@]}"; do
  gate_id="${entry%%:*}"
  gate_desc="${entry#*:}"
  gate_script="${LIB_DIR}/${gate_id}.sh"

  echo ""
  echo "----- ${gate_id}: ${gate_desc} -----"

  if [[ ! -x "${gate_script}" && ! -f "${gate_script}" ]]; then
    echo "release-candidate: ${gate_id} script missing: ${gate_script}" >&2
    exit 2
  fi

  rc=0
  bash "${gate_script}" || rc=$?
  if [[ "${rc}" -ne 0 ]]; then
    echo ""
    echo "FAIL: ${gate_id} (${gate_desc}) exited ${rc}" >&2
    echo "release-candidate: aborting; no tag suggestion emitted." >&2
    exit 1
  fi

  echo "OK: ${gate_id}"
done

echo ""
echo "----- emit-tag -----"
bash "${LIB_DIR}/emit-tag.sh"
