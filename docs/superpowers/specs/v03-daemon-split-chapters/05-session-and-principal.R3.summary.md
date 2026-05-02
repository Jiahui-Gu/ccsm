# R3 review — 05-session-and-principal

No reliability/observability findings. Chapter is about authorization and identity; R3 angles do not bear directly.

Two cross-references for the manager:

- §7 (restoring sessions on daemon restart) is the load-bearing reliability claim that ship-gate (b)/(c) depend on. The restore semantics ARE specified — re-spawn `claude` CLI with recorded cwd/env/args, replay snapshot, etc. This is sufficient for R3 angle 14 (daemon restart mid-session). NO FINDING.

- §5 enforcement matrix says "WatchSessions: filter the in-memory event bus by `principalKey(ctx.principal)`; never emit other-owner events on this stream". Reliability-positive: prevents leak of other principals' state on multi-principal v0.4. NO FINDING.

Note: the recommendation in chapter 04 R3 review to add a heartbeat variant to `SessionEvent` would touch §5's WatchSessions semantics; coordinate fix.
