#!/usr/bin/env bash
# Compile claude-sim. Invoked by the pty-soak-1h harness (#209 / #92)
# during test setup, so adding a dedicated CI workflow for a ~200-line
# binary is unnecessary — if the soak harness ever runs in CI, this
# script will fail loudly there.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="${1:-${here}/claude-sim}"

cd "${here}"
go build -trimpath -o "${out}" ./...
echo "claude-sim built: ${out}"
