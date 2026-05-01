#!/usr/bin/env bash
# Local extract of the sidecar-verify gate from .github/workflows/release.yml
# `publish` job. Run from a directory containing flattened release artifacts
# + sidecars (same layout as the workflow's dist-flat). Exits non-zero on
# missing sidecars; this mirrors the CI gate exactly so we can reverse-verify
# locally without pushing a tag.
#
# Usage:
#   cd <dir-with-installers-and-sidecars>
#   bash scripts/sidecar-verify-gate.sh
set -euo pipefail
PROV=$(ls *.intoto.jsonl 2>/dev/null | head -n1 || true)
if [ -z "$PROV" ]; then
  echo "::error title=Sidecar-verify failed::no *.intoto.jsonl SLSA provenance file present"
  exit 1
fi
fail=0
for f in *.exe *.dmg *.zip *.AppImage *.deb *.rpm; do
  [ -f "$f" ] || continue
  if [ ! -s "$f.sha256" ]; then
    echo "::error title=Sidecar-verify failed::$f missing or empty .sha256"; fail=1
  fi
  if [ ! -s "$f.minisig" ]; then
    echo "::error title=Sidecar-verify failed::$f missing or empty .minisig"; fail=1
  fi
done
if [ "$fail" -ne 0 ]; then
  echo "::error::Refusing to publish release with missing sidecars."
  exit 1
fi
echo "All installers have .sha256 + .minisig + .intoto.jsonl sidecars."
