#!/usr/bin/env bash
#
# gate-b.sh — SIGKILL reattach + SnapshotV1 gate.
#
# Two halves:
#   (1) SIGKILL → pty reattach e2e (T8.3, packages/electron/test/e2e/
#       sigkill-reattach.spec.ts). Verifies that killing the daemon
#       under load and bringing it back does not lose pty buffer state.
#   (2) SnapshotV1 codec round-trip (T8.5, packages/snapshot-codec
#       encoder + decoder specs). Verifies that the wire format the
#       reattach path depends on still round-trips byte-for-byte.
#
# Both must be green for v0.3 ship — losing buffer state on daemon
# crash is the central bet of the Electron-thin/daemon-fat refactor.

set -euo pipefail

# Allow override (used by release-candidate.spec.ts to inject a stub).
if [[ -n "${CCSM_RC_GATE_B_CMD:-}" ]]; then
  echo "gate-b: running override '${CCSM_RC_GATE_B_CMD}'"
  # shellcheck disable=SC2086
  ${CCSM_RC_GATE_B_CMD}
  exit $?
fi

echo "gate-b: (1/2) SnapshotV1 codec round-trip"
pnpm --filter @ccsm/snapshot-codec exec vitest run \
  src/__tests__/encoder.spec.ts \
  src/__tests__/decoder.spec.ts

echo "gate-b: (2/2) SIGKILL reattach e2e"
pnpm --filter @ccsm/electron exec vitest run \
  test/e2e/sigkill-reattach.spec.ts
