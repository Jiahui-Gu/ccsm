#!/usr/bin/env bash
# Local CI — what would have run on GitHub Actions if quota weren't exhausted.
# Invoked by .githooks/pre-push (installed via scripts/setup-hooks.sh) and
# also runnable directly: `bash scripts/ci.sh`.
#
# Fails fast on the first broken gate so you don't sit through later steps
# only to discover lint failed.

set -euo pipefail

cd "$(dirname "$0")/.."

step() {
  printf '\n\033[1;36m▶ %s\033[0m\n' "$1"
}

ok() {
  printf '\033[1;32m✓ %s\033[0m\n' "$1"
}

step 'typecheck'
npm run typecheck
ok 'typecheck'

step 'lint'
npm run lint
ok 'lint'

step 'test'
npm test -- --reporter=dot
ok 'test'

printf '\n\033[1;32m✅ all gates passed\033[0m\n'
