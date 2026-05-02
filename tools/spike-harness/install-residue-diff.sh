#!/usr/bin/env bash
# install-residue-diff.sh — diff filesystem state before/after install on macOS/Linux.
#
# Spike-harness helper pinned by spec ch14 §1.B (forever-stable contract).
# Used by ch14 §1.16 (installer comparison spike) and ch12 §3 ship-gate (d).
#
# Contract (FOREVER-STABLE — v0.4 may add flags, never rename/remove):
#
#   Usage:
#     install-residue-diff.sh snapshot <snapshot-file>
#       Walk a fixed list of roots and write a snapshot file (NDJSON).
#
#     install-residue-diff.sh diff <before-snapshot> <after-snapshot> [--allowlist=<file>]
#       Compare two snapshots; print added / removed / modified paths.
#
#   Snapshot file format (NDJSON, one path per line):
#     {"path":"<absolute>","size":<bytes>,"mode":<octal>,"mtime":<unix>,"sha256":"<hex>"}
#
#   Roots scanned (forever-stable; v0.4 additive only):
#     /Applications /Library/LaunchDaemons /Library/LaunchAgents
#     /usr/local/bin /usr/local/lib /usr/local/share
#     ~/Library/Application Support ~/Library/LaunchAgents
#
#   Output (diff mode, stdout, JSON):
#     {"added":[...],"removed":[...],"modified":[...],
#      "addedCount":<int>,"removedCount":<int>,"modifiedCount":<int>}
#
#   Exit 0 on success; 1 if diff non-empty AND no allowlist match;
#   2 on usage / IO error.
#
# TODO: implement walk + sha256 + diff when T9.16 lands. Contract above is
# forever-stable; the implementation (find / sha256sum / awk vs node) is not.
#
# Layer-1: bash + standard POSIX utilities (find, stat, sha256sum/shasum).

set -euo pipefail

MODE="${1:-}"

case "$MODE" in
  snapshot)
    OUT="${2:-}"
    if [ -z "$OUT" ]; then
      echo "usage: install-residue-diff.sh snapshot <snapshot-file>" >&2
      exit 2
    fi
    echo "TODO: implement when T9.16 lands — would walk roots and write $OUT" >&2
    : > "$OUT"
    exit 0
    ;;
  diff)
    BEFORE="${2:-}"
    AFTER="${3:-}"
    if [ -z "$BEFORE" ] || [ -z "$AFTER" ]; then
      echo "usage: install-residue-diff.sh diff <before> <after> [--allowlist=<file>]" >&2
      exit 2
    fi
    echo '{"added":[],"removed":[],"modified":[],"addedCount":0,"removedCount":0,"modifiedCount":0,"todo":"T9.16"}'
    exit 0
    ;;
  *)
    echo "usage: install-residue-diff.sh {snapshot|diff} ..." >&2
    exit 2
    ;;
esac
