# R0 (zero-rework) review of 04-proto-and-rpc-surface.md

## P0 findings (block ship; v0.3 design must change to remove future rework)

### P0.1 `Principal.kind` oneof reserves slot 2 with a comment, not `reserved`

**Location**: `04-proto-and-rpc-surface.md` §2 (and the recurring justification "Reservation slot for `cf_access` is a comment, not a `reserved` declaration")
**Issue**: The spec deliberately does NOT use protobuf's `reserved` keyword for the v0.4 `cf_access = 2` slot. Stated reason: "`reserved` blocks future field number reuse — exactly what we want to prevent." That reasoning is inverted. The additivity contract in §8.4 says "**No reuse of any field number, even for previously-unused ones.**" `reserved` is the protobuf-native, `buf breaking`-checkable mechanism that mechanically enforces exactly that rule. A comment does not. A v0.3.x patch (added between v0.3 ship and v0.4) could legally and without CI complaint use `oneof.kind { ... LocalUser local_user = 1; ServiceUser service_user = 2; }` — destroying v0.4's planned slot.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 message field whose semantics shift in v0.4" + the protocol-buffer-level mechanism for additivity is being rejected on incorrect reasoning.
**Suggested fix**: Replace every "comment-only reservation" in `.proto` files with `reserved <number>;` declarations (and `reserved "<name>";` for named slots). Specifically inside `Principal.kind`, declare `reserved 2;` with a sibling comment naming `cf_access`. Apply the same fix wherever else the spec uses comment-only reservation. Add a `buf` lint rule that requires every documented "reserved-for-future" slot to use the `reserved` keyword.

### P0.2 `Settings` is global in v0.3; v0.4 multi-principal forces semantic shift on existing field

**Location**: `04-proto-and-rpc-surface.md` §6; cross-ref `05-session-and-principal.md` §5; `15-zero-rework-audit.md` row "[05 §5]"
**Issue**: `SettingsService.{Get,Update}Settings` returns a single `Settings` message with no principal scoping. `GetSettingsRequest` carries no principal selector. v0.3 acknowledges this is "moot" because there's only one principal. The audit chapter says v0.4 adds a `settings_per_principal` table. But: v0.4 cf-access principals (potentially many on one daemon) calling `GetSettings` with no scope field will receive *the local-user's settings* — wrong answer — OR the daemon will silently switch to per-principal lookup, **changing the meaning of the existing RPC**. Brief §6: "MUST NOT reshape any existing v0.3 message (no field removals, no semantic changes...)". A handler that returns different data depending on `ctx.principal.kind` is a semantic change of the RPC.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 message field whose semantics shift in v0.4" applied to `Settings`/`GetSettingsResponse`.
**Suggested fix**: In v0.3 ship `GetSettingsRequest { RequestMeta meta = 1; SettingsScope scope = 2; }` with `enum SettingsScope { SETTINGS_SCOPE_UNSPECIFIED = 0; SETTINGS_SCOPE_GLOBAL = 1; SETTINGS_SCOPE_PRINCIPAL = 2; }`. v0.3 daemon accepts only `GLOBAL` (and `UNSPECIFIED` defaults to `GLOBAL`); v0.4 adds `PRINCIPAL` semantics additively. The wire shape is locked now; the v0.3 single-tenant assumption is encoded as "scope=GLOBAL" rather than baked into the absence of a field. Equivalent fix inside `Settings` itself: split into clearly-global fields (`crash_retention`) and a separate `PerPrincipalSettings` message used by a *new* RPC v0.3 doesn't ship — but that requires more structural change up front.

### P0.3 `CrashService.GetCrashLog` / `WatchCrashLog` semantics change in v0.4

**Location**: `04-proto-and-rpc-surface.md` §5; cross-ref `05-session-and-principal.md` §5 ("v0.3: open to any local-user principal")
**Issue**: In v0.3 these RPCs return all crash entries (no `owner_id` column). Audit chapter row "[05 §5]" says v0.4 adds `crash_log.owner_id` and "v0.4 may add an `owner_id` filter". Same issue as P0.2: the existing handler will start filtering by caller principal, changing what `GetCrashLog` returns for the same request. Plus existing v0.3 rows (all from local-user) will be migrated to either NULL (= "global", visible to everyone — PRIVACY LEAK to cf-access principals) or back-filled to `local-user:<uid>` (which migration?). The spec doesn't say.
**Why P0**: "Any v0.3 SQLite schema column whose semantics differ once cf-access principals exist" + RPC semantic shift.
**Suggested fix**: (a) In v0.3 add `string owner_filter = 4;` to `GetCrashLogRequest` (empty = caller's own; `"*"` = all, admin-gated in v0.4); v0.3 ignores all values except empty. (b) In v0.3 add the `owner_id` column to `crash_log` from day one (`001_initial.sql`), populated with `principalKey(ctx.principal)` on every insert. Then v0.4 just adds new principal kinds; no migration needed, no semantic shift, no privacy leak.

### P0.4 PTY worker_threads share the daemon address space across principals

**Location**: `06-pty-snapshot-delta.md` §1 (worker_threads choice cited via §15 audit table); affects every RPC handler in this chapter
**Issue**: The author chose `worker_threads` (not `child_process`) for per-session PTY hosts so that `Buffer` transfer is zero-copy. In v0.3 (single principal) this is fine. In v0.4 cf-access principals (delivered through Listener B) own sessions whose PTY workers share memory with the local-user principal's workers. A buggy or malicious PTY-host worker corrupts another principal's worker memory at the V8 heap level. There is no OS-level isolation. The same RPC handler code paths in this chapter (Attach/SendInput/Resize) accept input from both principal kinds — the daemon's threat model implicitly assumes all sessions belong to one trust domain.
**Why P0**: UNACCEPTABLE pattern "Any v0.3 single-tenant assumption that becomes wrong with multi-principal (Listener B brings cf-access principals)" — directly named.
**Suggested fix**: Either (a) downgrade to `child_process` per session in v0.3 (eats the perf cost the author tried to avoid; honest about the isolation requirement v0.4 will need), or (b) document and enforce in v0.3 that v0.4's cf-access principals MUST run their PTY workers in a separate daemon-spawned helper process (one helper per principal kind, not per session). The current spec leaves this as "acceptable in v0.3, hardened in v0.4" — that hardening is **not additive**, it requires reshaping `06 §1` to introduce a new process boundary. Lock the boundary now.

## P1 findings (must-fix-before-merge; ambiguity / soft-rework risk)

### P1.1 `client_version` duplicated between `RequestMeta` and `HelloRequest`

**Location**: `04-proto-and-rpc-surface.md` §2 (`RequestMeta.client_version`) and §3 (`HelloRequest.client_version`)
**Issue**: Both messages carry `string client_version`. The `Hello` flow gets it twice from the same payload. Both are forever-stable and won't be reworked in v0.4 — but the redundancy invites contributors to interpret one as authoritative and the other as legacy in v0.4, leading to a v0.5 deprecation that itself violates the additivity contract.
**Why P1**: Soft-rework risk; not a wire-breaker today.
**Suggested fix**: Remove `client_version = 3` from `HelloRequest`. Keep `RequestMeta.client_version` as the single source. (Equivalent: remove from `RequestMeta`, keep in `HelloRequest` — but RequestMeta is more general so prefer that one.)

### P1.2 `client_kind` is a free-form string, not `reserved`-protected enum

**Location**: `04-proto-and-rpc-surface.md` §3
**Issue**: `string client_kind` documented values "electron | web | ios". Free-form string means v0.5 can introduce `"electron-v2"` and silently fork behavior. The forever-stable rule says no semantic shifts — but with a free string the daemon cannot grep at compile time for unhandled cases.
**Why P1**: Soft additivity hazard.
**Suggested fix**: Use a string still (open set) BUT document in chapter 15 §3 forbidden-patterns: "daemon MUST NOT switch on `client_kind` for routing or auth decisions; it is observability-only." Already implied; make it explicit.

### P1.3 `Hello` does not return Listener id, only `daemon_version`

**Location**: `04-proto-and-rpc-surface.md` §3
**Issue**: A v0.4 client connecting through Listener B vs Listener A receives the same `HelloResponse`. The client cannot tell which listener it's on. Some v0.4 features (e.g., "tunnel status indicator" in web client) need to know. Adding `string listener_id = 5;` later is additive — fine — but if the client side starts inferring listener identity from latency or from URL parsing, the v0.4 web client codebase grows hacks the v0.3 design could have prevented.
**Why P1**: Avoidable v0.4-side complexity.
**Suggested fix**: Add `string listener_id = 5;` to `HelloResponse` in v0.3, populated as `"A"` always. v0.4 sets `"B"` on Listener B responses.
