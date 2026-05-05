# Review of chapter 04: Probe and harness update

Reviewer: R2 (security)
Round: 2

## Findings

No P0/P1 from R2 security in round 2.

Round-1 closures: none required (round-1 R2 had no P-tier findings on this chapter).

§4 new harness cases (`daemon-port-ready-before-render`, `loadstate-roundtrip`, `pty-input-roundtrip`, `pty-resize-roundtrip`, `pty-claude-available-roundtrip`, sigkill-reattach Set B) all run in-process against the existing loopback transport — no new attack surface. The §2 "Daemon stderr capture" path forwards daemon stderr into per-case logs which feed ch05 G11; structured-log format pinned in ch03 §6. Capture is best-effort and isolated to `tmp/e2e-logs/<run-id>/`, no remote sink — fine.

Note (informational, not a finding): if chapter 02 P2-1 (key validation) is later accepted, `loadstate-roundtrip` is the natural place to add an oversized-key + invalid-charset rejection assertion. Optional v0.4 follow-up.
