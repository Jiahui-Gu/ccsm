# R2 (Security) review — 15-zero-rework-audit

## P0

### P0-15-1 — Audit verdicts are "additive" / "none" but multiple v0.3 design choices are security-broken; additivity locks the brokenness

The audit table mechanically classifies every v0.4 delta as additive or none, gating ship on "no unacceptable verdicts". This is correct for *evolvability*, but per chapters 02–10 R2 reviews, several v0.3 choices are **security-broken**, and the audit's additivity guarantee means v0.4 inherits the bug forever:

- §2 row "[03 §6] `makeListenerB` throws in v0.3" → v0.4 just removes throw. If the JWT validator is defective at v0.4 ship, the whole tunnel is bypassable. Reviewer can't catch this in a v0.3 audit; spec must add a v0.4 *required* hardening test (cross-ref ch 12).
- §2 row "[05 §4] `assertOwnership` early return | gains optional admin clause" → admin clause is a wedge that bypasses ownership checks. The "additive" verdict masks the security expansion. Spec must require: any future admin clause needs explicit threat-model amendment, not just an additive code change.
- §2 row "[05 §5] Crash log + Settings open to any local-user in v0.3 | crash_log gains owner_id; settings gains per-principal table — existing rows valid as global" → "existing rows valid as global" means every v0.3-captured crash entry is readable by every v0.4 principal forever. This bakes in P0-09-1 PII leak across the upgrade boundary.
- §2 row "[09 §1] Capture sources list + `source` open string set" → unscrubbed v0.3 crash bytes uploaded by v0.4 additive uploader = data-protection breach. Audit verdict "additive" conceals this.

Spec must add a section "Security-relevant locked decisions that v0.4 cannot fix additively" — and require those to be re-designed in v0.3 before merge. Currently the audit treats *correctness additivity* as the only criterion.

### P0-15-2 — §3 forbidden patterns enforce wire/schema stability but not security invariants

The 12 forbidden patterns prevent reshape but do not forbid:
- Adding a new RPC that takes `bytes opaque_command` and forwards to a privileged subprocess.
- Adding a new principal kind that bypasses `assertOwnership` (no rule says "all principals must pass `assertOwnership` for session RPCs").
- Adding a new Listener (wait — pattern #6 forbids reshaping the array but a v0.5 amendment can extend it; per spec).
- Loosening peer-cred middleware (no rule pins the peer-cred algorithm).
- Adding a new Settings field that becomes a new code-execution primitive (cross-ref P0-04-3 `claude_binary_path` — an additive twin field would slip past audit).

Spec must extend §3 with security-shaped forbidden patterns, e.g., "any new field whose value is a path/URL that the daemon will exec or read MUST require admin peer-cred for write." This is exactly the "RPC that takes a path / file / process and does anything with it" enumeration the R2 brief asked for.

## P1

### P1-15-1 — §4 sub-decisions list omits all security-shaped author choices

§4 lists 10 reviewer-attention items: worker-thread vs child-process, snapshot format, descriptor file, big-bang Electron, WiX, `_ccsm` user, `crash-raw.ndjson`, XDG, transport bridge, installer tech. Author also made (without flagging):
- RPC-only ownership filter (chosen against R2 brief angle 12).
- No env scrubbing on claude spawn.
- No PTY input filtering.
- Non-admin `UpdateSettings` allowing `claude_binary_path` writes.
- No descriptor `boot_id` / atomic write.
- No installer signature verification.
- No crash-log PII scrubbing.

These need explicit reviewer-attention items because they each carry a P0 R2 finding.

### P1-15-2 — Closing rule "§5: stage 5 merge blocked on unacceptable verdict" — no equivalent block on P0 security finding

§5 hard-blocks merge on additivity violations. There is no parallel rule that hard-blocks merge on a P0 security finding from an R-reviewer. Spec must add: "any P0 finding from R2 (security) blocks merge until either resolved in spec or explicitly accepted with documented residual-risk and CVE-disclosure plan."

## P2

### P2-15-1 — §1 audit row §2 "Listener A protocol" verdict "additive" but the per-OS transport pick is the SOURCE of P0-03-1 / P0-03-2

The transport-pick decision propagates the security risk; classifying it as "additive" relative to v0.4 is technically correct (v0.4 doesn't change Listener A) but obscures the v0.3 security debt. Add an asterisk for security-relevant decisions, even when they're zero-rework-clean.

### P2-15-2 — Zero-rework rule does not interact with security-emergency releases

If a CVE in `node-pty` requires a wire-incompatible field rename, the zero-rework rule blocks the fix. Spec should carve out: "security-emergency releases may break additivity; release notes must explicitly call out the break and the upgrade path."
