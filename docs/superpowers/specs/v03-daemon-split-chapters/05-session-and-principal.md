# 05 — Session and Principal

Every Session in v0.3 is bound at create-time to a `Principal` recorded as `owner_id`. v0.3 has exactly one principal kind (`local-user`) derived from the peer-cred of the Listener A connection. Every session-touching RPC handler enforces `owner_id == ctx.principal.uid` at the RPC layer (not just SQL filter). This chapter pins the principal data model, the derivation rules, the enforcement points, and the additive path for v0.4 `cf-access:<sub>` principals — daemon code unchanged.

### 1. Principal model

In-process (TypeScript discriminated union, mirrors the proto oneof in [04](./04-proto-and-rpc-surface.md) §2):

```ts
// packages/daemon/src/principal.ts
export type Principal =
  | { kind: "local-user"; uid: string; displayName: string }
  // | { kind: "cf-access"; sub: string; aud: string; email?: string }   // v0.4
  ;

export function principalKey(p: Principal): string {
  switch (p.kind) {
    case "local-user": return `local-user:${p.uid}`;
    // case "cf-access":  return `cf-access:${p.sub}`;
  }
}
```

`principalKey` produces the canonical string used as the `owner_id` column value in SQLite. **The format is forever-stable** — `kind:identifier`. v0.4 adds new kinds; existing rows for `local-user:1000` (linux uid) or `local-user:S-1-5-21-...` (win SID) remain valid forever.

### 2. v0.3 single-principal invariant

In v0.3:
- The peer-cred middleware on Listener A is the only producer of principals.
- It always produces `kind: "local-user"`.
- The `uid` field is the OS-native identifier rendered as string: numeric uid on linux/mac, full SID string on Windows.
- The `displayName` is the OS-reported display name (best-effort; advisory; never used for authorization).

**The daemon does NOT have a "no principal" code path.** Every RPC handler reads `ctx.principal` and assumes it is set. If middleware did not set it, the daemon throws `Unauthenticated` before reaching any handler. This invariant is a guard against accidentally regressing in v0.4 when JWT-derived principals join the model.

### 3. Derivation rules per transport

| Transport | Mechanism | `uid` value | `displayName` source |
| --- | --- | --- | --- |
| UDS, linux | `getsockopt(SO_PEERCRED)` → uid | `String(ucred.uid)` | `getpwuid_r(uid).pw_gecos` (best-effort) |
| UDS, mac | `getsockopt(LOCAL_PEERCRED)` → xucred → cr_uid | `String(uid)` | `dscl . -read /Users/<name> RealName` (best-effort) |
| Named pipe, win | `ImpersonateNamedPipeClient` + `OpenThreadToken` + `GetTokenInformation(TokenUser)` | `LookupAccountSid` returns `SID-as-string` | `LookupAccountSid` returns name |
| Loopback TCP | OS-specific PID lookup → owning uid/SID (see [03](./03-listeners-and-transport.md) §5) | as above | as above |

Display name is best-effort only — if lookup fails, set to empty string and continue. **`uid` MUST resolve or the request is rejected with `Unauthenticated`.**

### 4. RPC-layer enforcement

Every session-touching handler runs an `assertOwnership(ctx.principal, session)` check before reading or writing session-scoped state. The check is **NOT** delegated to SQL — it is an explicit early return because:

(a) Listing RPCs filter by `owner_id` in SQL, but get/update/destroy RPCs take a session_id from the client; an SQL-only filter would return "not found" instead of "permission denied", and we want the distinction in logs.

(b) v0.4 with multiple principal kinds will need cross-principal admin RPCs (e.g., user with `local-user` principal lists everyone's sessions for support); the early return is the obvious place to add `if (principal.kind === "admin") return;`.

```ts
// packages/daemon/src/auth.ts
export function assertOwnership(p: Principal, s: Session): void {
  const sessionOwner = s.ownerId;          // e.g., "local-user:1000"
  const callerOwner = principalKey(p);     // e.g., "local-user:1000"
  if (sessionOwner !== callerOwner) {
    throw new ConnectError(
      "session not owned by caller",
      Code.PermissionDenied,
      undefined,
      [errorDetail("session.not_owned", { session_id: s.id })],
    );
  }
}
```

### 5. Per-RPC enforcement matrix

| RPC | Enforcement |
| --- | --- |
| `Hello` | none (returns the principal; auth already happened in middleware) |
| `ListSessions` | SQL `WHERE owner_id = ?` with `principalKey(ctx.principal)`; **no per-row check** because none escape the filter |
| `GetSession` | load by id; `assertOwnership` before returning |
| `CreateSession` | new session's `owner_id := principalKey(ctx.principal)`; no further check |
| `DestroySession` | load by id; `assertOwnership`; then delete + tear down PTY + kill claude CLI |
| `WatchSessions` | filter the in-memory event bus by `principalKey(ctx.principal)`; never emit other-owner events on this stream |
| `Attach` (PtyService) | load session by id; `assertOwnership`; then begin streaming |
| `SendInput` | as above |
| `Resize` | as above |
| `GetCrashLog` / `WatchCrashLog` | v0.3: open to any local-user principal (no owner column on crash_log); rationale below |
| `GetSettings` / `UpdateSettings` | v0.3: open to any local-user principal (settings are global to the daemon install) |

**Why crash log + settings are not principal-scoped in v0.3**: there is exactly one principal in v0.3, so scoping is moot. v0.4 with multiple principals MUST add an `owner_id` column on `crash_log` (additive: new column, default NULL = "global") and a per-principal `settings` table (additive: new table). Existing rows remain valid as global. See [15-zero-rework-audit](./15-zero-rework-audit.md).

### 6. Session create flow (canonical)

```
client                            daemon                                 sqlite        pty/claude
  │ CreateSession(cwd, env,         │                                       │               │
  │   claude_args, geometry)        │                                       │               │
  ├────────────────────────────────▶│                                       │               │
  │                                 │ ctx.principal = peerCred middleware   │               │
  │                                 │ id := ULID()                          │               │
  │                                 │ ownerId := principalKey(principal)    │               │
  │                                 │ INSERT into sessions (id, owner_id,   │               │
  │                                 │   state=STARTING, cwd, ...)──────────▶│               │
  │                                 │ spawn xterm-headless host             │               │
  │                                 │ spawn `claude` cli child──────────────┼──────────────▶│
  │                                 │ wire pty master ↔ claude stdio        │               │
  │                                 │ UPDATE state=RUNNING ─────────────────▶│               │
  │                                 │ emit SessionEvent.created on bus      │               │
  │ CreateSessionResponse(session)  │                                       │               │
  │◀────────────────────────────────┤                                       │               │
```

### 7. Restoring sessions on daemon restart

On daemon boot (per [02](./02-process-topology.md) §3 step 4), the daemon reads every session row with `state IN (STARTING, RUNNING)` and:

1. Re-spawns `claude` CLI with the recorded cwd, env, args.
2. Re-creates the xterm-headless host and replays the most recent snapshot from `pty_snapshot` table (see [07-data-and-state](./07-data-and-state.md) §3).
3. Updates state to `RUNNING` (or `CRASHED` if claude CLI fails to spawn) and writes a `crash_log` entry on failure.

The principal is **not** re-derived on daemon restart — the recorded `owner_id` in the row is authoritative. (The principal model deliberately makes the recorded id stable across reboots; `local-user:1000` is the same identity yesterday and today.)

### 8. v0.4 delta

- **Add** `cf-access:<sub>` to the `Principal` union; add `CfAccess` proto message; add JWT validator middleware on Listener B that produces it. Existing peer-cred middleware on Listener A: unchanged.
- **Add** `owner_id` column on `crash_log` (default NULL = global); existing rows valid.
- **Add** per-principal `settings_per_principal` table; existing global `settings` table remains as defaults.
- **Add** optional admin principal kind for support flows; `assertOwnership` gets one early-return clause.
- **Unchanged**: `Session.owner_id` column, `principalKey` format, every existing handler, every existing enforcement point, RPC-layer enforcement contract, session restore on boot.
