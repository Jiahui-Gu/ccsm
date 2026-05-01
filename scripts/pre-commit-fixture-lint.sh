#!/usr/bin/env bash
# Optional pre-commit hook for fixture lint.
#
# Symlink this into .git/hooks/pre-commit to enable per developer:
#   ln -sf ../../scripts/pre-commit-fixture-lint.sh .git/hooks/pre-commit
#
# See docs/dev/fixture-lint-pre-commit.md.
set -e
if git diff --cached --name-only | grep -qE '(__fixtures__|\.fixture\.json|test/fixtures|__tests__/.*/fixtures)'; then
  npm run lint:fixtures
fi
