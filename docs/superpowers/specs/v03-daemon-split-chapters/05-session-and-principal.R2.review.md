# R2 (Security) review — 05-session-and-principal

## P0

### P0-05-1 — Authorization is RPC-layer-only, not SQL-row-level; brief explicitly forbids this

§4: "The check is **NOT** delegated to SQL — it is an explicit early return because (a) ... we want the distinction in logs. (b) v0.4 ... will need cross-principal admin RPCs ...". Per R2 brief angle 12: "RPC-only filter = bypass possible if a future RPC is added without filter. SQL-only filter = good. Spec must mandate SQL-row-level filter." The spec deliberately picks RPC-only, contradicting the security threat model.

The two rationales are weak:
- (a) "want the distinction in logs": solved by the SQL layer returning a result + the RPC layer mapping zero-rows-but-row-exists-elsewhere to `PermissionDenied` instead of `NotFound`. This is the standard defence-in-depth pattern (`WHERE id=? AND owner_id=?` returns zero rows; a follow-up `SELECT 1 FROM sessions WHERE id=?` distinguishes "denied" from "missing").
- (b) "v0.4 admin RPCs need cross-principal access": admin RPCs add explicit allow-clauses; this does not justify removing SQL filters, it reinforces them (admin does `WHERE owner_id IN (...)`, not unfiltered).

Spec must mandate both: SQL `WHERE owner_id = ?` AND RPC-layer `assertOwnership`. Defence-in-depth. The spec's current design fails the brief's requirement explicitly.

### P0-05-2 — `crash_log` and `settings` are explicitly NOT principal-scoped in v0.3, and `settings.claude_binary_path` is a code-execution primitive (cross-ref 04-R2-3)

§5 last paragraph: "Why crash log + settings are not principal-scoped in v0.3: there is exactly one principal in v0.3, so scoping is moot." This rationale collapses on the Linux multi-user case where the spec adds users to group `ccsm` (ch 02 §2.3) so any group member can connect with their own peer-cred-derived principal. Each is `kind=local-user` with a distinct uid. There is **not** "exactly one principal" — there are N. The spec inadvertently runs in multi-principal mode without the protections that the audit defers to v0.4.

Concretely:
- User A reads user B's crash entries (PII leak, see 09-R2 review).
- User A calls `UpdateSettings({claude_binary_path: "/tmp/x"})` and user B's next session execs that binary as the daemon's service account.

Spec must either:
- Acknowledge multi-principal in v0.3 and scope crash/settings now (additive in v0.4 anyway per ch 15 audit row), OR
- Hard-fail any peer-cred whose uid != the installer-recorded "primary user" uid (single-user invariant enforced).

### P0-05-3 — Principal recorded as numeric `uid` (string-typed) is not stable across uid renumbering

§3: linux uid → `String(ucred.uid)`. UIDs are not globally stable across machine reinstalls or LDAP shifts; if the OS renumbers (`usermod -u`), every recorded `owner_id` becomes orphaned and §7 "principal is **not** re-derived on daemon restart — the recorded `owner_id` in the row is authoritative" means **the new uid for the same human is denied access to their own sessions**, while a new account that gets the old uid **inherits them**.

For a single-user box this is unlikely; for the Linux group-`ccsm` multi-user shared host it is plausible. Spec must either:
- Pin to a more stable identifier (Windows: SID is stable; macOS: UUID via `dscl`; Linux: GECOS / UUID derived from `/etc/machine-id` + uid).
- Or document the renumbering hazard and require migration tooling.

This is also the wedge that prevents v0.4 from cleanly mapping `cf-access:<sub>` to the legacy `local-user:<uid>` rows for a returning user.

## P1

### P1-05-1 — `Hello` returns the daemon-derived principal but doesn't bind it to the connection

§5 enforcement matrix: "Hello | none (returns the principal; auth already happened in middleware)". A streaming Connect connection lives across many RPC calls. If the client and daemon disagree about which principal is bound (e.g., re-auth after daemon-side mid-connection middleware change in v0.4 with cf-access JWT refresh), there's no spec for what happens. v0.3 must mandate: principal is bound at connection-establishment, never re-evaluated mid-connection; if changed, server closes the connection.

### P1-05-2 — `assertOwnership` early return on string compare; no canonicalisation specified

§4: `if (sessionOwner !== callerOwner) throw`. Both sides should be canonicalised (lowercase Windows SID? trim whitespace? normalise `local-user:01000` vs `local-user:1000`?). Spec must specify canonicalisation, else two semantically-equal principals could string-mismatch and either reject the legit owner or, worse, accept an attacker who finds an alternate string form.

### P1-05-3 — `principalKey` colon-separated format does not escape `:` in identifiers

§1: `local-user:${p.uid}`, `cf-access:${p.sub}`. Per RFC, JWT `sub` may contain colons (e.g., `urn:ietf:params:...`) → `cf-access:urn:ietf:params:oauth:client-id:foo` parses ambiguously when split on first/last colon. Spec must specify either:
- `kind` is a fixed enum with no colons; identifier is everything-after-first-colon (current implicit), AND identifier `:` is preserved literally — fine if every consumer respects "split on first colon only".
- OR percent-encode the identifier.

Pin this NOW because principalKey is forever-stable per ch 15 forbidden-pattern #7.

### P1-05-4 — `WatchSessions` filters in-memory bus by principalKey; no SQL/persisted enforcement

§5: "filter the in-memory event bus by `principalKey(ctx.principal)`; never emit other-owner events on this stream." If the in-memory bus implementation has a bug (e.g., race around session-create), other-principal events leak. Same SQL-defence-in-depth argument as P0-05-1: emit through SQL `WHERE` on each stream-event materialisation, not pure in-memory filter.

## P2

### P2-05-1 — Display name "best-effort; advisory; never used for authorization" — but appears in `Session.owner.display_name` returned to clients

If a client UI keys behaviour off display_name (typo, but also "is this the admin?" UX), spec should mandate the server NEVER uses display_name for any decision and the client SHOULD NOT either. State this as a contract.

### P2-05-2 — `should_be_running` semantics not bounded

Per ch 07 §3, `should_be_running INTEGER NOT NULL DEFAULT 1`. A malicious caller cannot directly set this, but `CreateSession` defaults it true; if user logs out and never destroys, sessions stay forever respawning across reboots. Spec needs an "abandon" path or a TTL.

### P2-05-3 — Session restore on boot trusts recorded `claude_args_json` and `env_json` verbatim

§7: "Re-spawns `claude` CLI with the recorded cwd, env, args." Combined with P0-04-1/P0-04-2 — once an attacker plants a session with malicious env, every reboot re-executes it. SQLite-row tampering (see 07 review) compounds.
