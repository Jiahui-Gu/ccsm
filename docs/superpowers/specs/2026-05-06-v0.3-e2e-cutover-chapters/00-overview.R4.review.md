# Review of chapter 00: Overview

Reviewer: R4 (Scalability / performance)
Round: 1

## Findings

No P0/P1/P2 from R4.

Chapter 00 is pure scoping / iron-rules / non-goals; it defines no hot
path, no resource budget, and no performance-sensitive contract. The
only perf-adjacent number cited (`>60s` `waitForTerminalReady` timeout
on cold sessions, line 30) is a problem statement, not a design
choice; it is correctly handed off to chapter 03. The "minimum-blast-radius"
framing keeps scope tight and is appropriate for a v0.3 single-machine
single-user release.

R4 concerns are accumulated against chapters 03 (daemon-port budget,
SSE pipe, sigkill-reattach buffer caps) and 01 (audit-level resource
inventory gap). See those `.R4.review.md` files.
