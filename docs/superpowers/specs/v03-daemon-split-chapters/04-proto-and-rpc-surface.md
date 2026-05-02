# 04 — Proto and RPC Surface

This chapter freezes the v0.3 wire schema. Every RPC the v0.3 Electron client uses is enumerated; every message shape is locked; every field is labeled forever-stable or v0.3-internal. The additivity contract from brief §6 is restated as a mechanical rule reviewers can grep for. v0.4 may add new RPCs and new optional fields; v0.4 MUST NOT remove a field, change a field's type, change a field's meaning, or rename anything in this chapter.

### 1. File and package layout

```
packages/proto/
  ccsm/v1/                     # v1 = forever-stable surface; never renamed
    common.proto               # shared scalar/enum/principal types
    session.proto              # SessionService
    pty.proto                  # PtyService (snapshot + delta stream)
    crash.proto                # CrashService
    settings.proto             # SettingsService
    supervisor.proto           # NOT shipped to clients; daemon-internal mirror of HTTP supervisor
  buf.yaml
  buf.gen.yaml                 # codegen: connect-es (TS) + connect-go (future) + connect-swift (future)
```

Package: `ccsm.v1`. **There is no `ccsm.v0`**; v0.3 is the first locked surface and is named v1 because the proto package name is forever-stable, not the product version. Future product versions add `ccsm.v2.*` packages alongside (additive); v1 is never removed (brief §6).

### 2. Common types (`common.proto`)

```proto
syntax = "proto3";
package ccsm.v1;

// Forever-stable. New principal kinds added as new oneof variants in v0.4.
message Principal {
  // F3: closes R0 03-P0.2 / R0 04-P0.1 — slot 2 reserved via the protobuf
  // `reserved` keyword (NOT a `// comment`) so any v0.3.x patch that tries
  // to bind a different message to field number 2 is rejected by `protoc`
  // before `buf breaking` even runs. v0.4 lifts the reservation by deleting
  // the `reserved 2;` line and adding `CfAccess cf_access = 2;` in the same
  // patch — the deletion-plus-add is a single atomic schema move and is
  // additive at the wire level (no v0.3 producer ever emitted field 2).
  oneof kind {
    LocalUser local_user = 1;
    reserved 2;                  // v0.4: CfAccess cf_access = 2;
  }
}

message LocalUser {
  string uid = 1;          // numeric uid (unix) or SID (windows), as string
  string display_name = 2; // OS-reported display name; advisory only
}

// Forever-stable. Surfaced to UI; ordering MUST match enum int values forever.
enum SessionState {
  SESSION_STATE_UNSPECIFIED = 0;
  SESSION_STATE_STARTING = 1;
  SESSION_STATE_RUNNING = 2;
  SESSION_STATE_EXITED = 3;
  SESSION_STATE_CRASHED = 4;
}

// Forever-stable. Used by every RPC for traceability.
message RequestMeta {
  string request_id = 1;       // client-generated UUIDv4
  string client_version = 2;   // semver of caller (electron / web / ios)
  int64 client_send_unix_ms = 3;
}

// Forever-stable error detail attached to ConnectError.details.
message ErrorDetail {
  string code = 1;             // stable string, e.g. "session.not_found"
  string message = 2;          // human-readable; UI may show
  map<string, string> extra = 3;
}
```

Reservation slot for `cf_access` uses the protobuf `reserved` keyword (not a comment) precisely **because** the keyword causes `protoc` to reject any attempt to reuse field number 2 with a different message — exactly the protection v0.3 wants. The earlier "comment is better because reserved blocks reuse" framing was inverted: the v0.4 add is `reserved 2;` deletion plus `CfAccess cf_access = 2;` insertion in the same patch (mechanically additive at the wire level — v0.3 producers never emit field 2 — and `buf breaking` accepts the move because no v0.3 message had `cf_access`). Every comment-only "v0.4 reserved" slot in this chapter MUST use `reserved <number>;` instead; reviewers grep for `// .*v0\.4.*reserved` and reject any hits in `.proto` files.

### 3. Session service (`session.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service SessionService {
  // Forever-stable.
  rpc Hello(HelloRequest) returns (HelloResponse);
  rpc ListSessions(ListSessionsRequest) returns (ListSessionsResponse);
  rpc GetSession(GetSessionRequest) returns (GetSessionResponse);
  rpc CreateSession(CreateSessionRequest) returns (CreateSessionResponse);
  rpc DestroySession(DestroySessionRequest) returns (DestroySessionResponse);
  rpc WatchSessions(WatchSessionsRequest) returns (stream SessionEvent);
}

message HelloRequest {
  RequestMeta meta = 1;
  string client_kind = 2;       // "electron" | "web" | "ios" — v0.3 only "electron"; open string set (see §3 below)
  // F3: closes R0 04-P1.1 — `client_version` is carried in `RequestMeta` only.
  // Field number 3 reserved so v0.4 cannot accidentally re-bind it.
  reserved 3;                    // historically `client_version`; now in RequestMeta.client_version
  int32 proto_min_version = 4;  // client's minimum acceptable v1 minor
}

message HelloResponse {
  RequestMeta meta = 1;
  string daemon_version = 2;
  int32 proto_version = 3;      // current v1 minor; client compares against its min
  Principal principal = 4;      // who the daemon thinks you are
  // F3: closes R0 04-P1.3 — listener id surfaces which listener answered the
  // handshake. v0.3 daemon ALWAYS populates "A" (the only listener instantiated);
  // v0.4 Listener B populates "B". Open string set so v0.5+ may add "C" etc.
  string listener_id = 5;       // "A" in v0.3; "B" on Listener B in v0.4
}

message ListSessionsRequest { RequestMeta meta = 1; }
message ListSessionsResponse {
  RequestMeta meta = 1;
  repeated Session sessions = 2;
}

message GetSessionRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message GetSessionResponse {
  RequestMeta meta = 1;
  Session session = 2;
}

message CreateSessionRequest {
  RequestMeta meta = 1;
  string cwd = 2;                       // absolute path; daemon validates exists + readable
  map<string, string> env = 3;          // additive env on top of daemon's service env
  repeated string claude_args = 4;      // argv for `claude` CLI; daemon prepends binary path
  PtyGeometry initial_geometry = 5;     // see pty.proto
}
message CreateSessionResponse {
  RequestMeta meta = 1;
  Session session = 2;
}

message DestroySessionRequest {
  RequestMeta meta = 1;
  string session_id = 2;
}
message DestroySessionResponse { RequestMeta meta = 1; }

<!-- F1: closes R0 04-P0.3 / R0 05-P0.2 — WatchSessions scope made explicit so v0.4 cross-principal admin filter is a value-add, not a semantic shift. -->
// Forever-stable. v0.3 daemon honors only WATCH_SCOPE_OWN; WATCH_SCOPE_ALL
// is reserved here so v0.4 (multi-principal + admin) flips behavior by enum
// value, not by reshaping the request. v0.3 daemon MUST reject ALL with
// PermissionDenied so v0.4 enforcement is purely an additive enum-branch.
enum WatchScope {
  WATCH_SCOPE_UNSPECIFIED = 0;     // treated as WATCH_SCOPE_OWN
  WATCH_SCOPE_OWN = 1;             // events for sessions owned by ctx.principal
  WATCH_SCOPE_ALL = 2;             // v0.4: admin principals only
}

message WatchSessionsRequest {
  RequestMeta meta = 1;
  WatchScope scope = 2;            // default UNSPECIFIED == OWN
}
message SessionEvent {
  oneof kind {
    Session created = 1;
    Session updated = 2;     // state, exit_code, geometry change, etc.
    string destroyed = 3;    // session_id
  }
}

// Forever-stable.
message Session {
  string id = 1;
  Principal owner = 2;
  SessionState state = 3;
  string cwd = 4;
  int64 created_unix_ms = 5;
  int64 last_active_unix_ms = 6;
  int32 exit_code = 7;       // valid only when state == EXITED
  PtyGeometry geometry = 8;
}
```

`Hello` does **not** authenticate — peer-cred middleware on Listener A already did that; `Hello` exists to negotiate protocol minor and surface the daemon-derived principal back to the client. The `client_kind` field is forever-stable and string-typed (not enum) so v0.5+ can add new client kinds without a proto bump. **`client_kind` is an open string set** — same wording as `CrashEntry.source` (§5) and `CrashEntry.source` open-set rule: string values are open; daemon and client both tolerate unknown values. v0.3 daemon does NOT branch on `client_kind` for behavior selection (forbidden by chapter [15](./15-zero-rework-audit.md) §3); the field is observability-only in v0.3. v0.3 publishes a known set `{"electron", "web", "ios"}` enumerated in this comment block; clients SHOULD pick a value from this set, but daemon MUST accept any UTF-8 string.

**Version negotiation is one-directional**: the client sends `proto_min_version` in `HelloRequest`; the daemon either accepts (returns its `proto_version` in `HelloResponse`) or rejects with `FAILED_PRECONDITION` and an `ErrorDetail` whose `code = "version.client_too_old"` and `extra["daemon_proto_version"] = <int>`. The daemon does NOT push a `min_compatible_client` value back; the client decides whether to upgrade based on its own embedded `proto_min_version` baseline. (This contract is mirrored in chapter [02](./02-process-topology.md) §6 wording.)

### 4. PTY service (`pty.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service PtyService {
  // Forever-stable. See chapter 06 for snapshot/delta wire format.
  rpc Attach(AttachRequest) returns (stream PtyFrame);   // server-stream
  rpc SendInput(SendInputRequest) returns (SendInputResponse);  // client → daemon keystrokes
  rpc Resize(ResizeRequest) returns (ResizeResponse);
  // F3: closes R0 06-P0.3 — per-frame ack ships in v0.3 so v0.4 web/iOS get
  // exactly-once delta application semantics WITHOUT a request-shape change.
  // v0.3 Electron MAY no-op (HTTP/2 flow control + the `since_seq` resume
  // tree (chapter 06 §5) already give the dogfood-needed reliability over
  // loopback); v0.4 web/iOS over CF Tunnel MUST set `requires_ack = true`
  // on `AttachRequest` and MUST call `AckPty(session_id, applied_seq)` after
  // each persisted frame so daemon can advance its per-subscriber seq watermark
  // and prune deltas safely.
  rpc AckPty(AckPtyRequest) returns (AckPtyResponse);
}

message PtyGeometry {
  int32 cols = 1;
  int32 rows = 2;
}

message AttachRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  // Last delta seq the client has; daemon resumes from here.
  // 0 means "send fresh snapshot then deltas from snapshot's seq".
  uint64 since_seq = 3;
  // F3: closes R0 06-P0.3 — opt-in per-frame ack channel.
  // v0.3 Electron leaves this `false` (default proto3 zero) — the server
  // streams freely; loopback HTTP/2 flow control suffices and the `since_seq`
  // resume tree handles disconnect cases. v0.4 web/iOS clients running over
  // CF Tunnel set this `true` and MUST call `AckPty` after each persisted
  // frame; daemon then bounds per-subscriber unacked-frame backlog (kicks
  // the subscriber with `RESOURCE_EXHAUSTED` if backlog exceeds N=4096).
  bool requires_ack = 4;
}

message AckPtyRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  uint64 applied_seq = 3;        // highest contiguous seq the client has persisted
}
message AckPtyResponse {
  RequestMeta meta = 1;
  uint64 daemon_max_seq = 2;     // highest seq daemon currently has buffered for this session
}

message PtyFrame {
  oneof kind {
    PtySnapshot snapshot = 1;   // sent at most once per Attach (first frame if since_seq=0
                                // OR if since_seq is older than retained delta window)
    PtyDelta delta = 2;         // may be sent many times
    PtyHeartbeat heartbeat = 3; // every 10s when no other frame; lets client detect stall
  }
}

// Forever-stable. Schema details in chapter 06.
message PtySnapshot {
  uint64 base_seq = 1;
  PtyGeometry geometry = 2;
  bytes screen_state = 3;       // serialized xterm-headless state; opaque to clients
  uint32 schema_version = 4;    // bump to add fields; never repurpose
}

message PtyDelta {
  uint64 seq = 1;               // strictly monotonic per session
  bytes payload = 2;            // chunk of raw VT bytes; see chapter 06 §3
  int64 ts_unix_ms = 3;
}

message PtyHeartbeat {
  uint64 last_seq = 1;
  int64 ts_unix_ms = 2;
}

message SendInputRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  bytes data = 3;               // raw bytes; daemon writes to PTY master
}
message SendInputResponse { RequestMeta meta = 1; }

message ResizeRequest {
  RequestMeta meta = 1;
  string session_id = 2;
  PtyGeometry geometry = 3;
}
message ResizeResponse { RequestMeta meta = 1; }
```

`SendInput` is unary, not bidi-stream, deliberately. **Why**: keystroke RTT over loopback is sub-millisecond; bidi-stream complicates the proto and Connect-web's bidi support is limited. v0.4 web client gets the same surface; if profiling shows unary overhead is unacceptable, v0.5 may ADD `SendInputStream` — existing `SendInput` stays.

### 5. Crash service (`crash.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

service CrashService {
  rpc GetCrashLog(GetCrashLogRequest) returns (GetCrashLogResponse);
  rpc WatchCrashLog(WatchCrashLogRequest) returns (stream CrashEntry);
}

<!-- F1: closes R0 04-P0.3 / R0 09-P0.1 / R0 05-P0.1 / R2 P0-05-2 — owner_filter pinned at v0.3 freeze so v0.4 multi-principal scoping is enum-additive, not a semantic flip. -->
// Forever-stable. v0.3 has a single principal kind so the filter is moot
// at runtime; v0.4 multi-principal makes UNSPECIFIED == OWN binding and
// adds OWNER_FILTER_ALL for admin principals. Defaults are forever-stable.
enum OwnerFilter {
  OWNER_FILTER_UNSPECIFIED = 0;    // treated as OWN
  OWNER_FILTER_OWN = 1;            // entries with owner_id == principalKey(ctx.principal) OR owner_id == "daemon-self"
  OWNER_FILTER_ALL = 2;            // v0.3: only the local-user principal MAY use this; v0.4: admin principals only
}

message GetCrashLogRequest {
  RequestMeta meta = 1;
  int32 limit = 2;            // max entries; daemon caps at 1000
  int64 since_unix_ms = 3;    // 0 = no lower bound
  OwnerFilter owner_filter = 4; // default UNSPECIFIED == OWN
}
message GetCrashLogResponse {
  RequestMeta meta = 1;
  repeated CrashEntry entries = 2;
}

message WatchCrashLogRequest {
  RequestMeta meta = 1;
  OwnerFilter owner_filter = 2; // same semantics as GetCrashLogRequest.owner_filter
}

// Forever-stable.
message CrashEntry {
  string id = 1;             // ULID
  int64 ts_unix_ms = 2;
  string source = 3;         // open string set; see chapter 09 §1 for v0.3 sources
  string summary = 4;        // single-line summary
  string detail = 5;         // multiline; stack trace if any
  map<string, string> labels = 6;  // session_id, pid, etc.
  string owner_id = 7;       // principalKey of attributable principal, or "daemon-self" for daemon-side crashes (chapter 09 §1)
}
```

`source` is a string (not enum) on purpose: new sources surface from the wild and must be addable without a proto bump. Daemon code SHOULD use a typed const set internally; the wire layer accepts any string from any version. The set is **open**; chapter [09](./09-crash-collector.md) §1 enumerates the v0.3 named sources but explicitly disclaims exhaustiveness — v0.4 may add sources additively (e.g., `claude_spawn`, `session_restore`) and v0.3 clients tolerate any value.

`owner_id` is a string with a single sentinel value `"daemon-self"` for crashes that are not attributable to a session principal (e.g., `sqlite_open`, `listener_bind`, `migration`, `watchdog_miss`). Session-attributable crashes (e.g., `claude_exit`, `pty_eof`, `worker_exit`) carry the owning session's `principalKey` as `owner_id`. v0.3 daemon enforces only that `OWNER_FILTER_ALL` is rejected for non-`local-user` principals; v0.4 adds full per-principal scoping additively (no proto reshape, no column add — the column ships from day one — see chapter [07](./07-data-and-state.md) §3 and chapter [09](./09-crash-collector.md) §1).

### 6. Settings service (`settings.proto`)

```proto
syntax = "proto3";
package ccsm.v1;
import "ccsm/v1/common.proto";

<!-- F1: closes R0 04-P0.2 / R0 07-P0.2 / R2 P0-04-3 — scope enum pinned at v0.3 freeze; security-sensitive keys removed from RPC entirely so v0.4 admin gating is config-file-only and additive. -->

service SettingsService {
  rpc GetSettings(GetSettingsRequest) returns (GetSettingsResponse);
  rpc UpdateSettings(UpdateSettingsRequest) returns (UpdateSettingsResponse);
}

// Forever-stable. v0.3 daemon honors only SETTINGS_SCOPE_GLOBAL; v0.4 adds
// SETTINGS_SCOPE_PRINCIPAL additively. The enum value lives at v0.3 freeze
// so v0.4 introduces no new oneof / no new request shape.
enum SettingsScope {
  SETTINGS_SCOPE_UNSPECIFIED = 0;  // treated as GLOBAL
  SETTINGS_SCOPE_GLOBAL = 1;       // single-row-per-key for the daemon install
  SETTINGS_SCOPE_PRINCIPAL = 2;    // v0.4: per-principal overrides; rejected with InvalidArgument in v0.3
}

message GetSettingsRequest {
  RequestMeta meta = 1;
  SettingsScope scope = 2;         // default UNSPECIFIED == GLOBAL
}
message GetSettingsResponse {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope effective_scope = 3; // echo of the scope the daemon resolved
}

message UpdateSettingsRequest {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope scope = 3;         // default UNSPECIFIED == GLOBAL
}
message UpdateSettingsResponse {
  RequestMeta meta = 1;
  Settings settings = 2;
  SettingsScope effective_scope = 3;
}

// Forever-stable wrapper. Field additions are additive (proto3 default to zero).
//
// SECURITY-SENSITIVE KEYS EXCLUDED FROM RPC.
// `claude_binary_path` and any other key that controls which executable the
// daemon spawns or which library it loads is a code-execution primitive and
// MUST NOT be settable via UpdateSettings. v0.3 reads these keys ONLY from
// the daemon config file written at install time (per-OS path in chapter
// [10](./10-build-package-installer.md) §5). The RPC surface deliberately
// omits a `claude_binary_path` field so the boundary is mechanical: there
// is no proto field to set. v0.4 keeps the same exclusion; if a per-user
// override is ever needed it ships as a separate AdminSettingsService gated
// on a peer-cred admin allowlist (additive new RPC, not a new field on the
// existing message). See chapter [05](./05-session-and-principal.md) §5
// "Per-RPC enforcement matrix" for the principal-side rule.
message Settings {
  // field 1 reserved historically for claude_binary_path; intentionally
  // omitted in v0.3 so the wire schema cannot carry it. Do NOT reuse field
  // number 1 for anything else (see chapter [15](./15-zero-rework-audit.md) §3).
  PtyGeometry default_geometry = 2;
  CrashRetention crash_retention = 3;
}

message CrashRetention {
  int32 max_entries = 1;       // daemon caps at 10000
  int32 max_age_days = 2;      // daemon caps at 90
}
```

The on-disk shape mirrors the wire enum: the SQLite `settings` table is keyed `(scope, key, value)` from day one with `scope = 'global'` for every v0.3 row (see chapter [07](./07-data-and-state.md) §3). v0.4 inserts rows with `scope = 'principal:<principalKey>'` additively; v0.3 rows remain valid as global defaults.

### 7. Forever-stable vs v0.3-internal labels

| Message / RPC | Status | Notes |
| --- | --- | --- |
| `Principal`, `LocalUser` | **forever-stable** | new principal kinds added as new oneof variants only |
| `SessionState` enum | **forever-stable** | new states append; existing values never repurposed |
| `RequestMeta`, `ErrorDetail` | **forever-stable** | every RPC carries these |
| `Session`, `PtyGeometry` | **forever-stable** | additions only via new optional fields with new field numbers |
| `SessionService.*`, `PtyService.*`, `CrashService.*`, `SettingsService.*` | **forever-stable** RPC names + signatures | new RPCs added as new methods only |
| `PtySnapshot.screen_state` byte payload | **v0.3-internal** | the *bytes field itself* is forever-stable; the encoding inside is gated by `schema_version`; see [06](./06-pty-snapshot-delta.md) for the v0.3 schema |
| `CrashEntry.source` string values | **v0.3-internal** (open set) | new values added freely; daemon and client both tolerate unknown |
| `HelloRequest.client_kind` string values | **v0.3-internal** (open set) | same rule as `CrashEntry.source`; v0.3 known set `{electron, web, ios}`; daemon MUST tolerate any UTF-8 string and MUST NOT branch behavior on the value (chapter [15](./15-zero-rework-audit.md) §3) |
| `HelloResponse.listener_id` string values | **v0.3-internal** (open set) | v0.3 always `"A"`; v0.4 adds `"B"`; clients tolerate unknown |
| Supervisor HTTP endpoints | **forever-stable** by URL + JSON shape | not Connect, not in proto |

The CI lint job runs `buf breaking` on every PR **from phase 1 onward** — pre-tag the comparison target is the PR's merge-base SHA on the working branch (so any in-flight PR that shifts a v0.3 message MUST be intentional and reviewed); post-tag the comparison target is the v0.3 release tag. This closes the "buf-breaking is disabled until v0.3 ships" gap that previously let a v0.3.x patch silently mutate the wire schema. In addition, every `.proto` file's SHA256 is recorded in `packages/proto/lock.json` (committed) and CI rejects any PR that touches a `.proto` file without bumping the matching SHA in `lock.json` (the bump is mechanical: `pnpm --filter @ccsm/proto run lock` regenerates and the PR author commits the result). See chapter [11](./11-monorepo-layout.md) §6 for the CI wiring and chapter [13](./13-release-slicing.md) §2 phase 1 for the "active from day one" milestone.

### 8. The additivity contract (mechanical)

For v0.4+ proto edits to be compliant, ALL of the following MUST hold:

1. No removal of any field, message, enum value, RPC, or service.
2. No type change of any existing field.
3. No semantic change of any existing field (documented by the `.proto` comment block above).
4. No reuse of any field number, even for previously-unused ones.
5. Any new field is added with a new field number and is `optional` in semantic terms (proto3 already makes scalars implicitly default-zero — that counts).
6. New oneof variants are appended; existing variants are never repurposed.
7. `buf breaking` against the v0.3 tagged commit (post-tag) or merge-base SHA (pre-tag) MUST pass; the gate is active from phase 1 onward, not deferred until ship.
8. Every `.proto` file mutation MUST be accompanied by a `packages/proto/lock.json` SHA bump for that file in the same PR; CI rejects mismatched PRs.

Reviewers MAY block any v0.4 PR that violates any of these mechanically.

### 9. v0.4 delta

- **Add** new RPCs (e.g., `TunnelService.GetStatus`, `TunnelService.SetEnabled`, `IdentityService.ListPrincipals`, `WebClientService.Register`) in new `.proto` files OR appended to existing services.
- **Add** new oneof variant `Principal.cf_access` with sibling `CfAccess` message — the `reserved 2;` line in `Principal.kind` is deleted in the same patch (additive at wire level — no v0.3 producer ever emitted field 2 — and `buf breaking` accepts the move).
- **Add** new optional fields to existing messages where needed (each with a new field number).
- **Unchanged**: every byte of the proto in this chapter; every existing field number; every existing RPC signature. (SnapshotV1 ships zstd-compressed in v0.3; no `schema_version = 2` is needed for compression — see chapter [06](./06-pty-snapshot-delta.md) §2.)
