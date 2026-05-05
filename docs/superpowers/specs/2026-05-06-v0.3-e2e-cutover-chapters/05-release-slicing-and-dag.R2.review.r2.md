# Review of chapter 05: Release slicing & DAG

Reviewer: R2 (security)
Round: 2

## Findings

No new P0/P1 from R2 security in round 2.

Round-1 closures:
- P2-1 (G9 widening to forbid daemon-bind-address widening) — CLOSED. §1 G9 row now reads "NO transport regression (no preload bridge reverted to IPC for a wave-2 endpoint) AND no daemon HTTP listen widening (cross-ref [ch03 §3](./03-ptyhost-wiring.md#loopback-bind-invariant) + [ch02 §1](./02-store-and-preload-surface.md#1-surface-catalog-what-lives-on-window) footer)" with mechanical tooling: `grep -rEn "createServer\|\.listen\(.*0\.0\.0\.0\|\.listen\(.*'::" daemon/ src/ electron/` MUST return 0 lines outside test fixtures. Exactly the gate shape requested in round-1; pairs cleanly with ch03 §3 MUST.

No regressions: G11 (daemon stderr zero error-level records) added in round-2 is a defense-in-depth gate — silently-swallowed daemon errors during a "green" run are now caught. PR DAG (§2) does not introduce any new daemon HTTP routes or new `daemon/api/*` files, consistent with HP-11 informational note on ch01.
