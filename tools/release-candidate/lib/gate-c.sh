#!/usr/bin/env bash
#
# gate-c.sh — pty-soak 1h gate. PLACEHOLDER for v0.3.
#
# Real implementation depends on T8.4 (.github/workflows/pty-soak.yml,
# tracked as #416 → #92 reopen). PR #880 was the first attempt and was
# CLOSED without merging, so there is no workflow for this script to
# pin against (no name, no input schema, no artifact path).
#
# v0.3 ship policy (manager 2026-05-05): pty-soak is NOT one of the 4
# dogfood gates. Shipping v0.3 on placeholder gate-c is intentional and
# documented in Task #414 / #415. Real impl lands in v0.4 ship cycle.
#
# Exit 0 (WARN, not FAIL) so the orchestrator continues to gate-d / emit-tag.

set -euo pipefail

cat <<'WARN'
WARN: gate-c (pty-soak 1h) is a PLACEHOLDER for v0.3.
      Real implementation blocked on T8.4 (#416, pty-soak.yml).
      See Task #415 for the v0.4 followup.
      Treating as PASS for v0.3 ship — this is the documented plan.
WARN

exit 0
