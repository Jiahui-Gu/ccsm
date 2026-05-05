# Review of chapter 03: ptyHost wiring

Reviewer: R2 (security)
Round: 2

## Findings

No new P0/P1 from R2 security in round 2.

Round-1 closures:
- P1-1 (loopback bind MUST) — CLOSED. §3 "Loopback bind invariant" block landed at lines ~413-422 with the full MUST text: daemon HTTP MUST bind `127.0.0.1` only; `0.0.0.0` / `::` / non-loopback = P0 regression; daemon has no auth so loopback is the sole trust boundary; widening requires independent RFC + user/product approval. Cross-refs to ch05 §1 G9 + ch02 §1 footer present. Mechanical gate G9 in ch05 grep-asserts `createServer | .listen(...0.0.0.0 | .listen(...::` returns 0 lines outside fixtures. This is exactly the closure shape requested in round-1.

Round-1 P2 carryover (still P2, manager-pinned defer):
- P2-1 pty-spawn child env MUST NOT include `CCSM_DAEMON_PORT` — defer.
- P2-2 SSE subscriber sid validation (per-window scoping for v0.4) — defer.

No regressions: round-2 additions (§3 spawnDaemon ready-signal contract, 10s timeout, error-token enum, daemon stderr structured-log format §6) all reduce attack surface or pin previously-implicit invariants — none widen exposure. The error-token enum closed-set + per-RPC subset (ch03 §5) is a defense-in-depth win: prevents accidental information disclosure through ad-hoc error strings. The §3 "Race after await" prove-or-pin requirement is a fixer-side discipline that does not affect the trust boundary.
