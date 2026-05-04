#!/usr/bin/env bash
#
# emit-tag.sh — final step of release-candidate.sh.
#
# We deliberately do NOT execute `git tag` ourselves. v0.3 ship plan
# (frozen) keeps tag emission as a manual user step so the human always
# eyeballs the SHA before a tag is created (and minisign signing is
# done in a separate, gated workflow). This script just prints the
# exact command the user should run.

set -euo pipefail

VERSION="${CCSM_RC_VERSION:-v0.3.0}"
SHA="$(git rev-parse HEAD)"

cat <<EOF
All gates green. Suggested next step:

    git tag ${VERSION} ${SHA}
    git push origin ${VERSION}

Reminder: ${VERSION} push triggers the release workflow. Make sure
minisign secrets are configured before pushing the tag.
EOF
