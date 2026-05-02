# R3 review — 01-overview

Overview chapter; no concrete reliability/observability commitments to audit. Goals 5 and 7 (PTY zero-loss reconnect, crash collector local-only) are the only R3-relevant commitments, and both are pinned in detail in chapters 06 and 09 — findings there.

Two minor observations (NOT findings, no fix required):

- Goals list (§1) does not enumerate "daemon is debuggable from logs" as a v0.3 goal. This is the root of the P0 logging gap surfaced against chapter 09. Adding "structured logs surfaced to a known per-OS path" to §1 would force chapter 09 (or a new chapter) to specify it.
- Non-goals table (§2) does not list "metrics endpoint" as deferred to v0.4. Reviewer flagging the absence in chapter 09 review.

No findings.
