# R2 (Security) review — 14-risks-and-spikes

## P1

### P1-14-1 — MUST-SPIKE register has no security-shaped spikes

§1 enumerates 15 spikes; all are functional (does X build / does Y run on OS Z). Per the security findings against chapters 02–10, the following SHOULD be MUST-SPIKE entries with hypothesis + validation + kill-criterion + fallback:

- **[security-dns-rebinding-loopback]**: hypothesis: a `Host:` header allowlist on Listener A's loopback-TCP transport blocks DNS-rebinding from a browser tab. Validation: VM with a malicious page in a desktop browser using `dns-rebinding.eu`-style harness, attempt to call `ListSessions`. Kill-criterion: any 2xx response. Fallback: drop loopback-TCP entirely; force named-pipe / UDS only.
- **[security-pid-recycle-tcp-peercred]**: hypothesis: `accept(2)` → `GetExtendedTcpTable` lookup race window is < 100 ms in practice. Validation: forced fork-exit-recycle harness. Kill-criterion: misattribution observed. Fallback: reject loopback TCP transport.
- **[security-osc52-filter-policy]**: hypothesis: a strict OSC-allowlist (only OSC 0/1/2 passthrough; drop OSC 4/52/104/8) preserves visible terminal UX in claude. Validation: 1-hour real-claude session against allowlist; ensure no missing functionality. Kill-criterion: any required UX broken. Fallback: explicit per-OSC opt-in setting.
- **[security-env-allowlist]**: hypothesis: a ~10-key allowlist (`CLAUDE_*`, `LANG`, `LC_*`, `TZ`, `TERM`, `COLUMNS`, `LINES`) suffices for claude. Validation: real-claude run with allowlist enforcement. Kill-criterion: claude fails. Fallback: case-by-case key admission via Settings (admin-only).
- **[security-descriptor-boot-id-roundtrip]**: hypothesis: Electron can verify `Supervisor /healthz` `boot_id` matches descriptor `boot_id` in < 50 ms. Validation: integration test. Kill-criterion: > 200 ms or false negatives. Fallback: persistent staleness warning UI.
- **[security-claude-as-user-uid]**: hypothesis: spawning claude with `setuid` to the connecting peer-cred uid (instead of the daemon's service account) preserves daemon isolation while giving claude access to the user's home dir / API key. Validation: per-OS. Kill-criterion: setuid blocked by sandboxing or service-account doesn't have CAP_SETUID. Fallback: distinct uid model TBD; escalate.

### P1-14-2 — Residual risk table omits security-relevant items

§2: "Connect-es / Connect-node version churn", "xterm-headless API changes", etc. Missing:
- Browser DNS-rebinding evolution (new browser features that affect loopback-TCP exposure, e.g., Private Network Access spec rollout).
- Node 22 V8 / OpenSSL CVEs requiring rebuilds; sea-binary rebuild + signing pipeline must be ready for emergency release.
- `node-pty` parser CVEs; `xterm-headless` parser CVEs — both are large attack surface.
- claude-CLI argv contract changes that turn previously-safe args into dangerous args (exec hooks, eval flags).

## P2

### P2-14-1 — Spike outcomes "feed the spec" (§3) but don't feed the test plan

A spike that lands "ship the loopback-TCP fallback" should automatically generate the security-test items in ch 12. Add to §3: "spike outcomes that ship a security-relevant fallback MUST add a corresponding regression test to ch 12."

No P0 findings; chapter is process.
