# Fragment: §6 reliability + §7 security expansion

**Owner**: worker dispatched per Task #936
**Target spec sections**: replace existing §6 and §7 in main spec
**P0 items addressed**: #11 (pino.final), #12 (pino-roll); plus §7 absorbs
the threat model post-hardening

## What to write here

### §6 Reliability (rewrite)
Existing §6 is thin. Expand to cover:
1. **Daemon supervision**:
   - Electron main spawns daemon; on daemon exit, supervisor decides:
     restart with backoff (1s → 2s → 4s ... cap 30s, reset after 60s
     stable), OR enter "crash loop detected" state after 5 restarts in
     2 min (surface UI, stop auto-restart, ask user).
   - Last-known-good binary: on auto-update, keep `daemon.bak`; if new
     daemon crash-loops, supervisor falls back to `.bak` automatically.
2. **Logging shutdown safety**:
   - `pino.final()` registered on daemon `beforeExit` and signal handlers
     (SIGTERM, SIGINT) so buffered log writes flush before exit. Without
     this, last-second crash logs are lost.
3. **Log rotation**:
   - `pino-roll` (or `pino-rotating-file` — pick one and justify) configured
     with daily rotation + 7 day retention + 50 MB per file cap. Files at
     `~/.ccsm/logs/daemon-YYYY-MM-DD.log`. Prevents unbounded disk usage
     (resource review noted this gap).
4. **Health probe**: daemon exposes `/healthz` RPC (no auth needed, local-only)
   returning uptime + active session count. Used by supervisor for liveness;
   future v0.4 adds `/readyz` for migration completion.

### §7 Security (rewrite)
Existing §7 understated. Expand to cover:
1. **Trust boundary (v0.3)**: same-machine, same-user. Enforced by:
   - Local socket only (no TCP listener at all in v0.3).
   - OS-level ACL/mode (§3.1.1).
   - Sender peer-cred verification per connection (§3.1.1).
2. **Defense in depth**: even with trust boundary, daemon validates every
   envelope schema (TypeBox), enforces frame caps (§3.4.1), and never
   shells out user-provided strings unescaped.
3. **Supply chain**:
   - Daemon binary published with SHA256 manifest in GitHub release.
   - Auto-update verifies SHA256 before swap (§3.1).
   - **Roadmap**: sigstore signing in v0.4 → flip auto-update default ON.
   - **Roadmap**: Cloudflare Access JWT validator middleware in v0.5 (seam
     already present from v0.3 §3.1).
4. **Threat model (post-hardening) table**: rows = attacker capability,
   columns = mitigation. e.g. "local non-admin user on same machine" → ACL
   denies; "remote attacker on LAN" → no listener; "compromised daemon
   binary on disk" → SHA256 verify on update (limited; full sig in v0.4).

Cite findings from `~/spike-reports/v03-review-reliability.md`,
`~/spike-reports/v03-review-security.md`,
`~/spike-reports/v03-review-observability.md`,
`~/spike-reports/v03-review-resource.md`.

## Plan delta
- Task 1 (workspace) gains: pino.final + pino-roll integration (+3h).
- New Task: supervisor backoff + crash loop detection (+4h).
- New Task: last-known-good rollback on auto-update (+3h).
- Task 7 (Connect client) gains: /healthz probe (+1h).
- §7 is doc-only mostly; threat model table tracking issue.
