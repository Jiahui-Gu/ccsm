# 06 — `proto/` schema (Connect-RPC source of truth)

## Scope

`proto/` is the single source of truth for the Connect-RPC data plane. **It contains every service required by every v0.4 client**, even ones not used in v0.3. Adding clients in v0.4 generates more stubs from the same schema — it does not change the schema.

**Why all-services-now:** final-architecture §2 principle 2 — "Three first-class clients (desktop, web, iOS). None is primary. All three consume the same `proto/` schema." Skipping a service in v0.3 would force v0.4 to bump schema versions, regenerate, and check breaking-change exemptions. Zero rework requires the schema be complete at v0.3 ship.

## Layout

```
proto/
  buf.yaml
  buf.gen.yaml
  ccsm/
    v1/
      pty.proto
      sessions.proto
      db.proto
      crash.proto
      daemon.proto
      common.proto      # shared messages (Empty-ish, Identifier types, Timestamp aliases)
  gen/
    ts/                 # generated TS stubs (committed)
      ccsm/v1/...
```

- Generated TS code (`proto/gen/ts/`) is committed (build hermeticity, fast install, no contributor protoc dance).
- All client generators (TS for desktop+web in v0.4, Swift for iOS in v0.4) emit into `proto/gen/<lang>/` from the same schema.

## Service surface

The five services below MUST exist at v0.3 ship. Every method's request/response messages MUST be defined. Method bodies (server handlers) MAY return `Unimplemented` for things v0.3 does not actually serve (`daemon.SetRemoteEnabled`); see [07 §"Stubbed methods"](./07-connect-server.md). What is forbidden is *adding* methods after v0.3 ship.

### `ccsm.v1.PtyService`

Per-session terminal interaction.

| Method      | Type                  | Purpose                                                                       |
| ----------- | --------------------- | ----------------------------------------------------------------------------- |
| `Spawn`     | unary                 | Create a new PTY-backed session; returns `sessionId`                          |
| `Input`     | unary                 | Send keystrokes / bytes to a session                                          |
| `Resize`    | unary                 | Resize PTY (cols, rows)                                                       |
| `Kill`      | unary                 | Send signal to PTY child; closes session                                      |
| `Subscribe` | server-streaming      | `(snapshot, delta-stream)`; first message = snapshot, then delta frames      |

**Server-streaming signature for `Subscribe`:**
```
rpc Subscribe(SubscribeRequest) returns (stream PtyEvent);

message SubscribeRequest {
  string session_id = 1;
  // Optional: client's last seen seq for delta-only resume. If absent → snapshot+full delta.
  optional uint64 from_seq = 2;
}

message PtyEvent {
  oneof event {
    PtySnapshot snapshot = 1;     // bounded ring-buffer dump; sent first
    PtyDelta    delta    = 2;     // {seq, bytes, ts}
    PtyExit     exit     = 3;     // PTY child exited
    PtyHeartbeat hb      = 4;     // server-side liveness ping (every 30s; configurable)
  }
}
```

**Why server-streaming, not bidi:** input is unary because each keystroke is a separate auth/log boundary; bidi would conflate. Server→client stream is the only direction needing high-throughput. Web (connect-web over fetch) supports server-streaming reliably; bidi support in browsers requires HTTP/2-explicit transport which not all proxies pass through. Pinning to server-streaming = max client compatibility.

### `ccsm.v1.SessionsService`

Session lifecycle and metadata.

| Method      | Type                  | Purpose                                                  |
| ----------- | --------------------- | -------------------------------------------------------- |
| `List`      | unary                 | All sessions (active + recent, bounded)                 |
| `Get`       | unary                 | One session by id                                        |
| `Update`    | unary                 | Mutate metadata (title, color, pinned)                  |
| `Close`     | unary                 | End session (kill PTY, archive to DB)                   |
| `Subscribe` | server-streaming      | Push session-list deltas (created / updated / closed)   |

### `ccsm.v1.DbService`

Generic key-value access for app state (settings, prefs, last-opened, etc.). Replaces all v0.2-era IPC-based storage paths.

| Method   | Type   | Purpose                                |
| -------- | ------ | -------------------------------------- |
| `Get`    | unary  | Read by key                            |
| `Set`    | unary  | Write key→value                        |
| `List`   | unary  | List keys with optional prefix filter  |
| `Delete` | unary  | Remove key                             |

Values are bytes (client decides encoding). Keys are strings, dotted-namespace convention (`ui.sidebar.collapsed`, `app.lastSession`).

### `ccsm.v1.CrashService`

Renderer / Electron-main / daemon crash report submission and listing.

| Method   | Type   | Purpose                                                     |
| -------- | ------ | ----------------------------------------------------------- |
| `Report` | unary  | Submit a crash payload (stack, breadcrumbs, sentry envelope) |
| `List`   | unary  | List recent crash reports (for in-app diagnostics view)     |

### `ccsm.v1.DaemonService`

Daemon-level info and control.

| Method               | Type   | Purpose                                                                      |
| -------------------- | ------ | ---------------------------------------------------------------------------- |
| `Info`               | unary  | `{ version, bootNonce, uptime_s, listeners }` (data-plane echo of supervisor info) |
| `SetRemoteEnabled`   | unary  | Toggle cloudflared sidecar (v0.4); v0.3 returns `Unimplemented`              |
| `GetRemoteStatus`    | unary  | Returns `{ enabled, sidecar_running, public_url? }`; v0.3 returns `{enabled:false, sidecar_running:false}` |

**Why `SetRemoteEnabled` exists in v0.3 schema even though server returns `Unimplemented`:** schema additions in v0.4 would force `buf breaking` exemptions and re-roll all client generators. Defining the method now means v0.4's only change is replacing `Unimplemented` with a real handler.

## Common types (`ccsm/v1/common.proto`)

- `message SessionId { string value = 1; }`
- `message Timestamp { google.protobuf.Timestamp ts = 1; }` (alias for clarity in service signatures)
- `enum PtySignal { SIGTERM = 0; SIGKILL = 1; SIGINT = 2; SIGHUP = 3; }`

Use Google well-known types where standard (`google.protobuf.Empty`, `Timestamp`, `Duration`).

## Versioning + breaking-change discipline

- Package: `ccsm.v1`. All v0.3 + v0.4 work under v1.
- `ccsm.v2` is reserved for future incompatible breaks; out of scope.
- `buf breaking --against '.git#branch=working'` runs on every PR touching `proto/**` in CI. **Hard fail** on any breaking change.
- `buf lint` runs on every PR touching `proto/**` in CI.
- `buf format --diff` runs in CI to enforce style.

## Generation pipeline

- Tooling: `buf` CLI + `protoc-gen-es` + `protoc-gen-connect-es` for TypeScript.
- Trigger: `npm run proto:gen` script (manual + CI dirty-check).
- CI dirty-check: after `npm run proto:gen` in CI, `git diff --exit-code proto/gen/` MUST pass — i.e. committed generated code matches what regen would produce.
- For Swift (v0.4 iOS), `protoc-gen-connect-swift` is added at v0.4 time; not in v0.3 toolchain.

## What `proto/` does NOT contain

- No request-tracing fields (trace-id is server-issued via Connect interceptor metadata, see [03 §"Logging"](./03-listener-A-peer-cred.md)).
- No HMAC / token / nonce fields. Auth is transport-bound.
- No envelope-related fields. The envelope lives only on the supervisor plane (see [05](./05-supervisor-control-plane.md)).
- No "v0.5 placeholder" fields. If a future feature needs a field, it adds the field then (additive proto changes are non-breaking).

## Cross-refs

- [01 — Goals (G2)](./01-goals-and-non-goals.md)
- [07 — Connect-Node server (consumes the generated TS stubs)](./07-connect-server.md)
- [08 — Session model (defines server-streaming semantics for `pty.Subscribe` / `sessions.Subscribe`)](./08-session-model.md)
- [10 — SQLite + db RPC (DbService handler surface)](./10-sqlite-and-db-rpc.md)
- [11 — Crash + observability (CrashService handler surface)](./11-crash-and-observability.md)
- [12 — Electron thin client (consumes the generated TS stubs)](./12-electron-thin-client.md)
- [15 — Testing strategy (proto contract tests)](./15-testing-strategy.md)
