# Review of chapter 04: Probe and harness update

Reviewer: R2 (security)
Round: 1

## Findings

No P0/P1/P2 from R2 security.

Chapter is harness-side diagnostic refresh + skip inventory reconciliation. No new attack surface; the new harness cases proposed in §4 (`daemon-port-ready-before-render`, `sigkill-reattach`, `loadstate-roundtrip`) all run in-process against the existing loopback transport. No security-relevant changes.

Note (not a finding): the new `loadstate-roundtrip` case in §4 will exercise `window.ccsm.saveState/loadState` with an arbitrary key — if chapter 02 P2-1 (key validation) is accepted, this harness case becomes the natural place to also assert oversized-key rejection. Optional follow-up for the chapter 02 fixer.
