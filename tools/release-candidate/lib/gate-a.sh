#!/usr/bin/env bash
#
# gate-a.sh — IPC residue gate.
#
# Delegates to T8.1's `pnpm lint:no-ipc` (which itself calls
# tools/lint-no-ipc.sh). Forbidden IPC patterns in electron/ or src/
# fail this gate; nothing else does.
#
# A gate-a failure means the v0.3 Electron-thin / daemon-fat split has
# regressed and the build is shipping ipcMain/ipcRenderer/contextBridge
# residue. Hard fail — there is no v0.3 ship without this being green.

set -euo pipefail

# Allow override (used by release-candidate.spec.ts to inject a stub).
LINT_CMD="${CCSM_RC_GATE_A_CMD:-pnpm lint:no-ipc}"

echo "gate-a: running '${LINT_CMD}'"
# shellcheck disable=SC2086
${LINT_CMD}
