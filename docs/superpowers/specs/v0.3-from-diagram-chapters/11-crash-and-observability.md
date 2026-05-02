# 11 — Crash collector + observability

## Scope

Crash reporting (Sentry) + log rotation move into the daemon. Electron renderer + main still capture their own crashes but submit through Connect-RPC `CrashService` over Listener A — no direct Sentry HTTP calls from Electron.

**Why daemon-collected:** principle 1 (backend owns state); principle 9 (daemon survives Electron). If Electron is the one talking to Sentry, daemon-side crashes go missing whenever Electron isn't running. Funneling through daemon means the daemon retries uploads, has consistent symbol-upload pairing, and one crash store on disk.

## Source layout

```
daemon/src/crash/
  collector.ts       # CrashService implementation (Report, List)
  uploader.ts        # background queue: read crash_reports.uploaded=0, upload to Sentry, mark uploaded
  symbols.ts         # post-pkg sourcemap upload pairing helpers (build-time only)
  __tests__/
```

## CrashService surface

See [06 §CrashService](./06-proto-schema.md). Two methods:

- `Report(payload)` — Electron renderer + Electron main + daemon itself call this with a serialized Sentry envelope. Stored in `crash_reports` table (see [10](./10-sqlite-and-db-rpc.md)).
- `List()` — for in-app diagnostics ("recent crashes" view in Settings); v0.3 may not surface this UI but the RPC exists.

`Report` is fire-and-forget from the client perspective (returns ack as soon as the row is INSERTed). The actual Sentry network upload is async via the uploader.

## Uploader

- Polls `crash_reports WHERE uploaded = 0 ORDER BY occurred_at` on a 30s interval (or on Report-trigger).
- Uploads via Sentry HTTP envelope endpoint with the daemon's bundled DSN.
- On 2xx → mark `uploaded = 1`.
- On 5xx / network fail → leave `uploaded = 0`, exponential backoff up to 1h.
- On 4xx → log and mark `uploaded = 1` (don't retry forever a malformed payload).
- Cap retained uploaded reports: most recent 100 (drop older).

## Renderer crash capture

- Electron renderer keeps its existing Sentry SDK init.
- The renderer's transport is overridden to call Connect `CrashService.Report` instead of HTTP-to-sentry. (Sentry SDK supports custom transport.)

## Electron main crash capture

- Electron main's Sentry init also uses the Connect-RPC transport.
- Electron main's uncaughtException / unhandledRejection handlers call `CrashService.Report` synchronously where possible (best-effort before exit).

## Daemon crash capture

- Daemon's pino logger captures errors.
- Daemon's own uncaughtException handler writes a synchronous crash row to SQLite, then exits.
- On next daemon boot, uploader will pick up the row.

## Sentry symbol upload (resolves task #62 KEEP from reconciliation)

Per the reconciliation, option (a) — pre-pkg sourcemap upload — is the chosen path:

- During the build pipeline, **before** `pkg`-bundling the daemon binary, sourcemaps are uploaded to Sentry tagged with the build's release id.
- The same release id is baked into the daemon binary as a constant (build-time `process.env.SENTRY_RELEASE`).
- At runtime, every Sentry event from daemon includes the release id; Sentry symbolicates against the pre-uploaded sourcemaps.

For Electron renderer + main, the existing v0.2 sourcemap upload pipeline is preserved (no change).

**Why pre-pkg:** post-pkg sourcemaps reference the bundled file structure inside the binary, which Sentry can't resolve. Pre-pkg sourcemaps are paired with the unbundled JS that the bundler can resolve.

## Crash dataRoot (resolves task #58 KEEP)

- All crash artifacts live under `<dataRoot>` (no scattered locations). Specifically: `<dataRoot>/crashes/` for any auxiliary minidump files (Electron crashpad still writes minidumps to disk; their root is reconfigured to `<dataRoot>/crashes/electron-main/` and `<dataRoot>/crashes/renderer/`).
- The daemon's own crash records live in SQLite (see [10](./10-sqlite-and-db-rpc.md) `crash_reports` table).

## Logging (pino)

- Daemon writes structured JSON logs via pino to `<dataRoot>/logs/daemon-<YYYYMMDD>.log`.
- Daily rotation (open new file at UTC midnight); max 7 files retained.
- Per-RPC log line format (see [03 §logging](./03-listener-A-peer-cred.md), [04 §logging](./04-listener-B-jwt.md)):
  ```
  { ts, level, listener: 'A'|'B'|'supervisor', rpc, trace_id, identity?, latency_ms, status, ... }
  ```
- pino redact list (security-sensitive fields): `req.headers["cf-access-jwt-assertion"]`, `jwt`, `secret`, `token`, `password`. Existing v0.3 frag-7 redact list is the baseline; HMAC-related entries are removed (no longer applicable).

## Observability hooks for v0.4 (deferred but doors open)

- Trace IDs are server-issued at every RPC accept; identical mechanism applies whether listener is A or B. v0.4 web/iOS clients will inherit this for free.
- The crash uploader is shared across all sources (renderer/main/daemon) and will be shared for web/iOS clients too once their crash transport routes through `CrashService.Report` over Listener B.

**Why deferred:** v0.3 has no web/iOS to send crashes; v0.4 just adds new transport-side wiring. Daemon code is unchanged.

## Cross-refs

- [01 — Goals](./01-goals-and-non-goals.md)
- [06 — Proto (CrashService surface)](./06-proto-schema.md)
- [07 — Connect server](./07-connect-server.md)
- [10 — SQLite (crash_reports schema)](./10-sqlite-and-db-rpc.md)
- [12 — Electron (Sentry transport override)](./12-electron-thin-client.md)
- [13 — Packaging (pre-pkg sourcemap upload pipeline)](./13-packaging-and-release.md)
