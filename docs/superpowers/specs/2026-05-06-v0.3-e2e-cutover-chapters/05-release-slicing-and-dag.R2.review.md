# Review of chapter 05: Release slicing & DAG

Reviewer: R2 (security)
Round: 1

## Findings

### P2-1 (nice-to-have): gate G9 should explicitly forbid daemon-bind-address widening

**Where**: chapter 05, §1 "Top-level v0.3 e2e iron rules" table, gate G9 (line ~22).

**Issue**: G9 reads "NO transport regression (no preload bridge reverted to IPC for a wave-2 endpoint)". This catches the IPC-reversion direction but not the "widen daemon HTTP exposure beyond loopback" direction. See chapter 03 R2 P1-1 for full reasoning — the daemon has zero auth and `pty.write` is arbitrary shell exec, so loopback binding is the trust boundary. A fixer who flips `127.0.0.1` to `0.0.0.0` "for v0.4 web frontend prep" passes G9 today.

**Why this is P2** (paired with chapter 03 P1-1 which is P1): G9 wording is the mechanical-verification angle. The MUST belongs in chapter 03 (the design); G9 in chapter 05 is the gate that proves the MUST held. Either or both can land.

**Suggested fix**: change G9 to "NO transport regression AND no widening of daemon HTTP listen address (must remain `127.0.0.1`-only) — verified by `grep` for `'0.0.0.0'` / `'::'` / non-loopback bind in `daemon/http/*` diff." Tooling line in the same row updates to `grep diff for ipcRenderer.invoke + grep diff for daemon listen address`.

## Cross-file findings (if any)

P2-1 here is the gate-side counterpart of chapter 03 R2 P1-1. Single fixer should land both.
