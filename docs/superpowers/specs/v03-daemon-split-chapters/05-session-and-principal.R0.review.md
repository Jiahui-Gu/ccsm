# R0 (zero-rework) review of 05-session-and-principal.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 Crash log + Settings principal-scoping deferred to v0.4 forces semantic shift

**Location**: `05-session-and-principal.md` §5 ("Why crash log + settings are not principal-scoped in v0.3"); reflected in `04-proto-and-rpc-surface.md` §5–6 and `07-data-and-state.md` §3
**Issue**: The chapter explicitly defers `owner_id` on `crash_log` and a `settings_per_principal` table to v0.4. Both are documented as "additive: new column, default NULL = global" / "additive: new table; existing global table remains as defaults." This sounds additive but is not: existing v0.3 rows in `crash_log` were written by `local-user:<X>` and become `NULL = "global"` after migration, which means **every cf-access principal that lands on the daemon in v0.4 sees the local-user's historical crashes**. The same RPC (`GetCrashLog`) returns different results for different principals in v0.4 — a semantic change of an existing RPC's behavior. Brief §6: "MUST NOT reshape any existing v0.3 message" / no semantic changes on existing fields.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 SQLite schema column whose semantics differ once cf-access principals exist" + "Any v0.3 single-tenant assumption that becomes wrong with multi-principal".
**Suggested fix**: In v0.3 ship `crash_log.owner_id TEXT NOT NULL` (defaults to `principalKey(ctx.principal)` at insert time, or to a literal sentinel `"daemon-self"` for daemon-internal sources like `sqlite_open` that have no caller). The column is populated from day one. v0.4 just adds new principal kinds — no migration needed, no semantic shift, no privacy leak. Mirror this for any other table flagged for "v0.4 additive owner_id" treatment.

### P0.2 `WatchSessions` event-bus filter is implicit and not principal-keyed in storage

**Location**: `05-session-and-principal.md` §5 (per-RPC enforcement matrix, `WatchSessions` row)
**Issue**: "filter the in-memory event bus by `principalKey(ctx.principal)`; never emit other-owner events on this stream". In v0.3 the bus has one principal of events. In v0.4 the bus carries events for `local-user:<X>`, `cf-access:<sub1>`, `cf-access:<sub2>`, etc. The filter as written says "events whose `Session.owner == ctx.principal`" — fine for current `local-user` topology, but consider an admin v0.4 principal kind (which the chapter §8 anticipates: "Add optional admin principal kind for support flows; `assertOwnership` gets one early-return clause") — admin must see ALL events. The current filter formulation has no scope parameter. v0.4 must either (a) add a NEW `WatchAllSessions` RPC (additive — fine), or (b) modify `WatchSessions` to switch behavior on `ctx.principal.kind` (semantic shift — UNACCEPTABLE).
**Why P0**: Path (b) is the obvious implementation in v0.4 because (a) means the Electron client and the cf-access admin web UI use *different* RPCs — duplicating the same proto-generated client code. The temptation to take path (b) is structural unless the v0.3 design closes it off.
**Suggested fix**: Add `WatchSessionsRequest.scope` field in v0.3 (closed enum: `WATCH_SCOPE_OWN = 0; WATCH_SCOPE_ALL = 1;`). v0.3 daemon enforces `scope == WATCH_SCOPE_OWN` (rejects ALL with `PermissionDenied`). v0.4 admin principal can pass `WATCH_SCOPE_ALL` and the same RPC serves both — no semantic shift, no new RPC.

### P0.3 `local-user` principal `uid` is OS-account-specific; v0.4 same-human-different-channel breaks identity continuity

**Location**: `05-session-and-principal.md` §1, §3
**Issue**: `principalKey({kind:"local-user", uid:"S-1-5-21-..."})` is `"local-user:S-1-5-21-..."`. When v0.4 the same physical human reaches the daemon through cloudflared with a federated GitHub identity, their principal is `"cf-access:user@example.com"`. These are **different** `owner_id` values. Sessions the user created via Electron (under `local-user:S-1-5-21-...`) become invisible to the same human's web UI session (under `cf-access:user@example.com`). This is a v0.4 UX bug whose fix requires either (a) a `principal_aliases` join table (additive — fine), or (b) reshaping the `owner_id` model to a stable cross-channel id (UNACCEPTABLE — column semantic change). Without forethought, v0.4 will choose (b) under user pressure.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 daemon-side state keyed by something Electron-specific (window id, OS user, process pid) that doesn't generalize". The OS user is an Electron-specific identity from the v0.4 web client's POV.
**Suggested fix**: Add an explicit `principal_aliases` table in v0.3's `001_initial.sql` (empty in v0.3, structurally present): `principal_aliases(canonical_id TEXT NOT NULL, alias_id TEXT NOT NULL UNIQUE, ...)`. Document that v0.3 never writes to it but v0.4 populates it when a user proves cf-access ↔ local-user equivalence (e.g., one-time pairing flow). RPCs that filter by `owner_id` extend in v0.4 to `owner_id IN (canonical) UNION (aliases)` — additively. Without the table existing now, v0.4 adds it and must rewrite every existing query.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 `assertOwnership` early-return strategy assumes admin clause is the only future branch

**Location**: `05-session-and-principal.md` §4 (rationale (b))
**Issue**: "v0.4 with multiple principal kinds will need cross-principal admin RPCs ... the early return is the obvious place to add `if (principal.kind === "admin") return;`." This presumes admin is the only cross-principal pattern. v0.4 may also want delegation (principal A grants principal B read-only access to a session), shared-team sessions, etc. Each becomes another `if` in `assertOwnership` — eventually a behavior table not a one-liner.
**Why P1**: Soft-rework risk; the chapter overcommits to a specific shape of the v0.4 admin extension.
**Suggested fix**: Reframe `assertOwnership(p, s)` as `assertAccess(p, s, capability: "read"|"write"|"destroy")` from v0.3 onward. v0.3 passes `capability` based on the RPC and rejects unless `principalKey(p) === s.ownerId`. v0.4 plugs in a richer access policy keyed on `capability`. The signature is forever-stable; the body grows additively.

### P1.2 `principalKey` format `kind:identifier` collides if identifier contains `:`

**Location**: `05-session-and-principal.md` §1
**Issue**: `principalKey` is `${kind}:${uid}`. SIDs contain dashes (no colons) and unix uids are numeric, so v0.3 is safe. But `cf-access:<sub>` will have `sub` from a JWT — by RFC 7519 `sub` is a free-form string and CAN contain colons (e.g., URN-style `sub: "urn:github:42"`). Parsing back into `(kind, identifier)` becomes ambiguous. The format is documented as forever-stable.
**Why P1**: A v0.4 forced-escape (e.g., switching to URL-encoded identifier) WOULD violate the forever-stable rule.
**Suggested fix**: Lock the v0.3 grammar to "first colon is the separator; everything after the first colon is the identifier verbatim" (which is already the natural reading, but say it). Add a unit test asserting `principalKey({kind:"cf-access", sub:"urn:github:42"})` round-trips correctly. Document in chapter 15 §3.

### P1.3 Restored sessions trust recorded `owner_id` even if the OS uid no longer exists

**Location**: `05-session-and-principal.md` §7
**Issue**: "The principal is **not** re-derived on daemon restart — the recorded `owner_id` in the row is authoritative." Correct for stability across reboots. But: if the OS user `1000` is deleted and a new user gets uid `1000` (rare on personal machines, common on shared boxes), the new human silently inherits the old human's sessions on next reattach.
**Why P1**: Single-tenant edge case; v0.4 cf-access doesn't have this issue (sub claims are not recycled). v0.3 lives with it but should document.
**Suggested fix**: Add a v0.3 boot-time check: if `principals.first_seen_ms` is older than X days AND the OS lookup of the current uid returns a different display_name than recorded, mark sessions `state = CRASHED` with a `crash_log` entry "principal identity changed; sessions quarantined". UI surfaces; user explicitly reclaims.
