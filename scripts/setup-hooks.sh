#!/usr/bin/env bash
# One-shot installer: tells git to use .githooks/ as the hooks directory
# (instead of the default .git/hooks/, which is not under version control).
# Run once after cloning.

set -e

cd "$(git rev-parse --show-toplevel)"

git config core.hooksPath .githooks
chmod +x .githooks/* 2>/dev/null || true

echo "✓ git hooks now sourced from .githooks/"
echo "  Pre-push runs: typecheck → lint → test (skip with --no-verify)"
