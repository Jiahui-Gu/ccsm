#!/usr/bin/env bash
#
# gate-d.sh — installer roundtrip gate. PLACEHOLDER for v0.3.
#
# Real implementation depends on T8.6 (.github/workflows/installer-
# roundtrip.yml, tracked as #417 → #95 followup). PR #902 merged the
# tools/installer-roundtrip.sh / .ps1 *shell* but NOT the workflow yml,
# so there is no CI surface for this script to pin against.
#
# v0.3 ship policy (manager 2026-05-05): installer roundtrip is NOT one
# of the 4 dogfood gates. v0.3 ships on macOS+linux with a documented
# asymmetric gate set (see ch12 §4.4 and tools/installer-roundtrip.sh).
#
# Exit 0 (WARN, not FAIL) so the orchestrator continues to emit-tag.

set -euo pipefail

cat <<'WARN'
WARN: gate-d (installer roundtrip) is a PLACEHOLDER for v0.3.
      Real implementation blocked on T8.6 (#417, installer-roundtrip.yml).
      See Task #415 for the v0.4 followup.
      Treating as PASS for v0.3 ship — this is the documented plan.
WARN

exit 0
