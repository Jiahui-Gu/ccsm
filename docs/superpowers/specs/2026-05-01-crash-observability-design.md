# Crash observability — design spec

> Task #1069. Closes the gap exposed by the 2026-05-01 16:18 user crash where
> nothing on disk and nothing in Sentry survived to diagnose the failure.
>
> Framed around the v0.3 dual-process topology:
>
> - **frontend** = electron-main + renderer (one Electron app, shared lifecycle)
> - **backend**  = `ccsm-daemon` (separate Node process spawned by electron-main;
>   owns PTY fan-out, sqlite, supervisor + data sockets)
>
> The two processes can crash independently. Today neither leaves a usable
> artifact in shipped builds. Goal of this spec: every crash, on either side,
> leaves a recoverable bundle on disk *before* we even talk about Sentry.

---

## §1 Goals

1. Every crash on either process produces a local artifact bundle the user
   can attach to a bug report — even with `SENTRY_DSN` empty and no network.
2. When the daemon dies, the frontend captures **why** (exit code, signal,
   last-N stderr, last RPC `traceId`, `bootNonce`) and links it to whatever
   the user did just before.
3. Sentry, when configured, receives matched events from both processes
   correlated by a single incident `traceId`, so a daemon SIGSEGV and the
   resulting renderer "stream dead" toast appear as one incident.
4. Crash artifacts are PII-safe by default (`$HOME` scrubbed to `~`, env
   redacted, window titles dropped). Opt-out preference (`crashReportingOptOut`)
   continues to gate network upload but never blocks local capture.
5. Native crashes (Crashpad `.dmp`) ship with a symbol upload pipeline so
   stacks are human-readable in Sentry.
6. A "Send last crash" Help-menu entry bundles the most recent N incidents
   into a zip the user can attach to email or drag to an issue, with no extra
   tooling.

## §2 Non-goals

- Real-time crash dashboards / alerting (Sentry side, out of scope).
- Performance / APM tracing of healthy operation (see frag-12 traceability).
- Capturing GPU process memory dumps beyond what Crashpad already produces.
- Auto-restart policies for the daemon (lives in v0.3 supervisor, not here).
- macOS Notarization-friendly minidump symbol stripping (separate ticket).
- Replaying a crashed PTY session — capture only, not recovery.

## §3 Current state — per-process

Grouped by the v0.3 dual-process split. `(not present)` = no code path exists.
Citations are `path:line` against `origin/working` HEAD `0f965ff`.

### Frontend (electron-main + renderer)

| Process       | Failure mode                       | Today                                                                                                                                  | Gap                                                                                          |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| electron-main | `uncaughtException`                | `console.error` only, no Sentry forward, no disk write — `electron/main.ts:46-48`                                                      | comment at `:40-42` admits "TODO: forward to Sentry once main-process Sentry transport is wired"; nothing routes to Sentry or disk |
| electron-main | `unhandledRejection`               | `console.error` only — `electron/main.ts:43-45`                                                                                        | same as above; lost on quit                                                                  |
| electron-main | Sentry init                        | `initSentry()` called at `electron/main.ts:52`; reads `process.env.SENTRY_DSN` only — `electron/sentry/init.ts:18-22`                  | release builds ship with empty env → DSN undefined → init returns early → **all main-proc events go nowhere** |
| electron-main | GPU process / utility helper crash | (not present) — no `app.on('child-process-gone')` or `app.on('render-process-gone')` listener anywhere in `electron/`                  | silent helper deaths; no diagnostic artifact                                                 |
| electron-main | Crashpad native dmp                | electron-main inherits Electron's default Crashpad bootstrap; `setUploadToServer` never called; no `app.setPath('crashDumps', ...)`    | dmps land in Electron-default location, never uploaded, never bundled                        |
| electron-main | Structured runtime log             | (not present) — `console.info/warn/error` to stdout/stderr only, no rotating file sink                                                 | once the user closes the dev console there is no record                                      |
| renderer      | React render error                 | `@sentry/react` `ErrorBoundary` wraps `<App />` with a static fallback — `src/index.tsx:51-59`                                         | works *if* DSN is wired; otherwise just shows fallback, no disk capture                      |
| renderer      | window `error` / `unhandledrejection` | `sentryInit({})` at `src/index.tsx:15` auto-installs window handlers via `@sentry/electron/renderer`; preload bridges via `@sentry/electron/preload` (`electron/preload/index.ts:9`) | depends entirely on main-proc DSN; no fallback path                                          |
| renderer      | persist failure                    | routed to `captureException` + `console.error` — `src/index.tsx:21-28`                                                                 | DSN-gated; lost without it                                                                   |
| renderer      | blank screen / white-of-death      | (not present) — no watchdog comparing `did-finish-load` vs subsequent paint                                                            | indistinguishable from "user is reading"                                                     |
| renderer      | hang detection                     | (not present)                                                                                                                          | no `responsive` / `unresponsive` window event handler                                        |
| renderer crash reporting opt-out | cached prefs predicate                       | `loadCrashReportingOptOut()` consulted in `beforeSend` — `electron/sentry/init.ts:28-35`, cache invalidated via `subscribeCrashReportingInvalidation()` (`electron/main.ts:188`) | works correctly; no change needed                                                            |

### Backend (ccsm-daemon)

| Process       | Failure mode                       | Today                                                                                                                                  | Gap                                                                                          |
| ------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| ccsm-daemon   | `uncaughtException`                | (not present) — `daemon/src/index.ts` registers only `SIGTERM`/`SIGINT` (`:118-119`); no `process.on('uncaughtException')`             | a thrown error in any handler kills the daemon with no log, no Sentry, no marker file        |
| ccsm-daemon   | `unhandledRejection`               | (not present)                                                                                                                          | same as above                                                                                |
| ccsm-daemon   | Sentry init                        | (not present) — daemon does not import `@sentry/node`                                                                                  | crashes invisible even with DSN configured                                                   |
| ccsm-daemon   | structured logs                    | `pino` JSON to stdout — `daemon/src/index.ts:18-25`; no file sink, no rotation                                                         | when daemon dies, supervisor inherits stdio (dev: `dev-watch.ts:44`); prod has no supervisor yet |
| ccsm-daemon   | shutdown actions error reporting   | `recordStepError` and `recordDeadlineOverrun` log to pino — `daemon/src/index.ts:85-93`                                                | only fires for orderly-shutdown overrun, not for hard crash                                  |
| ccsm-daemon   | native crash (Crashpad)            | (not present) — daemon is plain Node, no `crashReporter` analog                                                                        | SIGSEGV in `better-sqlite3` / `node-pty` produces zero artifact                              |
| electron-main | daemon supervision                 | (not present in `working` HEAD) — only dev path `scripts/dev-watch.ts:37-42` spawns nodemon → daemon; `electron/main.ts` does **not** spawn the daemon binary at `extraResources/daemon/ccsm-daemon[.exe]` | prod electron-main has nothing to detect daemon exit, no place to capture stderr             |
| electron-main | daemon-event renderer fanout       | typed bus exists — `src/lib/daemon-events.ts` (`bootChanged` / `streamDead` / `unreachable`); producer (`useDaemonReconnectBridge` T69) not yet on `working` | no toast says "backend died", only "stream dead"; no link to a crash bundle                  |

Bottom line: in shipped v0.2.0, **neither process** writes a crash artifact
anywhere reachable. The 16:18 incident left exactly nothing because there is
nothing that would have written anything.

## §4 Architecture

```
                    ┌─ frontend (one Electron app) ─────────────────┐
                    │                                               │
   user UI ─────────┤  renderer  ── @sentry/electron/renderer       │
                    │     │                                         │
                    │     │ preload bridge                          │
                    │     ▼                                         │
                    │  electron-main ── @sentry/electron/main       │
                    │     │   │                                     │
                    │     │   └── crash collector (NEW) ─┐          │
                    │     │           │                  │          │
                    │     │           │ writes           │ uploads  │
                    │     │           ▼                  ▼          │
                    │     │   %LOCALAPPDATA%/CCSM/    Sentry        │
                    │     │   crashes/<incident>/    (DSN-gated)    │
                    │     │                                         │
                    │     │ supervises (NEW)                        │
                    │     ▼                                         │
                    │  ccsm-daemon child ── stderr ring buffer ─────┼──┐
                    └───────────────────────────────────────────────┘  │
                                                                       │
                    ┌─ backend (separate process) ──────────────────┐  │
                    │  ccsm-daemon                                  │  │
                    │     ├── pino → stdout (existing)              │  │
                    │     ├── pino → rolling file (NEW)             │  │
                    │     ├── @sentry/node init (NEW, DSN forwarded)│  │
                    │     ├── uncaught/unhandled handlers (NEW)     │  │
                    │     └── on death: marker file + flush logs ───┼──┘
                    └───────────────────────────────────────────────┘
                                                                       │
                                                                       ▼
                                              one umbrella incident dir
                                              with frontend.* + backend.*
                                              + meta.json (traceId, nonce…)
```

The crash collector lives in electron-main because:

- It already owns lifecycle, knows `app.getVersion()`, and has the only
  Electron crashReporter handle.
- It is the only process that *survives* a daemon crash, so it must own
  daemon stderr capture + post-mortem bundling.
- A daemon-side collector still exists (writes its own `backend.dmp` /
  `backend.log` / drops a marker) but defers the **bundling + Sentry envelope**
  to the next electron-main run.

## §5 Per-surface design

### §5.1 Frontend crashes (electron-main + renderer + GPU + helpers)

**electron-main**

- Replace `console.error`-only handlers (`electron/main.ts:43-48`) with
  forwarders that:
  1. write a JSONL line to the rolling logfile (§5.5);
  2. call `Sentry.captureException(err, { tags: { surface: 'main' } })` if
     init succeeded;
  3. write a `meta.json` shard into the current incident dir (§10).
- Subscribe `app.on('render-process-gone', ...)` and
  `app.on('child-process-gone', ...)` (covers GPU, utility, pepper plugin,
  zygote). Log the `details.reason`, `details.exitCode`, last 200 lines of
  the renderer console (forward via existing IPC log channel — frag-6-7 §6.6.2),
  trigger the same incident bundle path.
- Configure Electron crashReporter explicitly:
  `crashReporter.start({ submitURL: '', uploadToServer: false, compress: true })`
  before `app.whenReady()`. We *write* dmps but do not *upload via Crashpad's
  HTTP path*; the collector reads them and ships through Sentry's native-events
  endpoint so the same DSN gating + opt-out applies.
- Override `app.setPath('crashDumps', join(localAppData, 'CCSM', 'crashes',
  '_dmp-staging'))` so we control the directory layout.

**renderer**

- Keep current `ErrorBoundary` + `sentryInit({})`.
- Add a window-hang watchdog: in main, listen to `BrowserWindow.on('unresponsive')`
  / `'responsive'`. On `unresponsive` lasting > 5s, snapshot via
  `webContents.capturePage()` (PNG into the incident dir), record event.
- Add a blank-screen probe: 3s after `did-finish-load` send an IPC ping the
  preload responds to; if no response in 5s, treat as render-side hang.

**Interface added/changed**

- New module `electron/crash/collector.ts`:
  - `export function startCrashCollector(opts: CollectorOpts): CrashCollector`
  - `interface CrashCollector { recordIncident(input: IncidentInput): IncidentDir; flush(): Promise<void> }`
  - `interface IncidentInput { surface: 'main' | 'renderer' | 'gpu' | 'helper' | 'daemon-exit' | 'daemon-uncaught'; error?: SerializedError; exitCode?: number | null; signal?: string | null; tail?: string[]; lastTraceId?: string; bootNonce?: string }`
- New IPC channel `ccsm:crash:report-from-renderer` (preload → main),
  payload `{ message, stack, source, lineno, colno }`.
- New IPC channel `ccsm:crash:list-incidents` (renderer query for "Send last
  crash" UI).
- New env var `SENTRY_DSN` (existing) + `CCSM_CRASH_DSN` (alias accepted so a
  fork can override without touching `SENTRY_DSN`).
- Build-time injection: `webpack.DefinePlugin` and electron-builder
  `extraMetadata.sentryDsn` populate `process.env.SENTRY_DSN` at packaged-app
  boot from a CI secret (see §6).

### §5.2 Backend crashes (ccsm-daemon: uncaught + native + exit-code)

- Add `process.on('uncaughtException', err => recordAndDie(err, 'uncaught'))`
  and `process.on('unhandledRejection', reason => recordAndDie(reason, 'unhandled'))`
  in `daemon/src/index.ts` *before* the dispatcher wiring at line 101.
- `recordAndDie`:
  1. `pino.fatal({ event: 'daemon.crash', err })` (synchronous flush);
  2. write `<runtimeRoot>/crash/<bootNonce>.json` with `{ bootNonce, ts,
     surface, kind, message, stack, lastTraceId }`;
  3. if `@sentry/node` was initialized, `Sentry.captureException` with
     `flush(2000)`;
  4. `process.exit(70)` (sysexits `EX_SOFTWARE`) so electron-main's supervisor
     can distinguish crash (70) from orderly shutdown (0).
- Initialize `@sentry/node` at the top of `daemon/src/index.ts` reading
  `CCSM_DAEMON_DSN ?? SENTRY_DSN` from env. The frontend forwards the DSN
  it bootstrapped with as a child env var on spawn.
- For native crashes there is no Crashpad in the daemon process. Two options
  evaluated:
  - **A**: link `@sentry/node` + `node-segfault-handler` for native stack
    capture on POSIX. Windows requires a separate dbghelp shim.
  - **B**: rely on electron-main's exit-code + stderr-tail capture (§5.3).
    No native dump but we still know "SIGSEGV at <last RPC traceId>".
  - Recommendation: ship **B** in phase 1, evaluate **A** in phase 3 once we
    have a baseline of how often native crashes actually fire in the wild.

**Interface added/changed**

- New module `daemon/src/crash/handlers.ts`:
  - `export function installCrashHandlers(opts: { logger: pino.Logger; bootNonce: string; runtimeRoot: string; getLastTraceId(): string | undefined }): void`
- New env vars `CCSM_DAEMON_DSN` (preferred), falls back to `SENTRY_DSN`.
- New on-disk artifact `<runtimeRoot>/crash/<bootNonce>.json` (the marker the
  next electron-main boot picks up).

### §5.3 Cross-process correlation (the new critical section)

When the daemon dies and electron-main is still running:

1. Electron-main supervises the daemon child via the v0.3 supervisor work
   (still landing on a feature branch — `working` does not yet contain the
   prod-side spawn; `scripts/dev-watch.ts` is the dev-only stand-in). Add an
   `electron/daemon/supervisor.ts` (or extend whatever lands first) so it owns
   `child = spawn(daemonBinaryPath, [], { stdio: ['ignore', 'pipe', 'pipe'] })`.
2. Maintain a 200-line ring buffer per stream (stdout, stderr) using a small
   `RingBuffer<string>` keyed by line. Lines also tee to the rolling daemon
   logfile (§5.5).
3. Track the last successful RPC `traceId` and the daemon's `bootNonce` (sent
   on `daemon.hello` reply — already wire-defined in
   `daemon/src/handlers/daemon-hello.ts`).
4. On `child.on('exit', (code, signal) => …)`:
   - generate an incident `traceId` (ULID);
   - synthesize an `IncidentInput` with `surface: 'daemon-exit'`, `exitCode`,
     `signal`, `tail: ringBuffer.snapshot()`, `lastTraceId`, `bootNonce`;
   - call `crashCollector.recordIncident(...)` → returns the incident dir;
   - if a marker file `<runtimeRoot>/crash/<bootNonce>.json` exists, move it
     into the incident dir as `daemon-marker.json` (this is the daemon-side
     `recordAndDie` artifact);
   - send IPC `ccsm:daemon-crash` to renderer with `{ incidentId, exitCode,
     signal }` so the existing `daemonEventBus.emit('unreachable', ...)` toast
     can offer "View crash report" → opens the incident dir in OS file
     manager.
5. On next supervisor restart, the new daemon child is given a fresh
   `bootNonce`; the renderer's `bootChanged` event already exists
   (`src/lib/daemon-events.ts:27-29`) and will trigger resubscribe.

When the daemon dies *during boot* (before `daemon.hello` succeeds):
- electron-main has no `bootNonce` yet → use a synthetic `boot-pending-<ulid>`.
- The marker file path is a wildcard scan: on next electron-main boot, the
  collector scans `<runtimeRoot>/crash/*.json`, attaches every untouched
  marker to the next incident, then renames to `*.consumed.json`.

**Interface added/changed**

- New module `electron/daemon/supervisor.ts` (assumed by v0.3 work; this spec
  adds the crash hooks):
  - `interface DaemonChild { child: ChildProcess; ringStdout: RingBuffer<string>; ringStderr: RingBuffer<string>; bootNonce?: string; lastTraceId?: string }`
  - `function attachCrashCapture(handle: DaemonChild, collector: CrashCollector): void`
- New IPC channel `ccsm:daemon-crash` (main → renderer):
  `{ incidentId: string; exitCode: number | null; signal: string | null; bootNonce?: string }`.
- New env var `CCSM_RUNTIME_ROOT` (already proposed in v0.3 plan; the crash
  dir hangs off it).

### §5.4 Native crashes (Crashpad — dmp generation, upload, symbol pipeline)

- electron-main process: Crashpad already runs by default; we explicitly
  configure it (see §5.1) to write into `<crashDir>/_dmp-staging/`. After each
  crash event the collector moves any new `*.dmp` from staging into the
  active incident dir as `frontend.dmp`.
- daemon process: not Electron, no Crashpad. Phase 1 captures only the exit
  signal + stderr tail. Phase 3 may add `node-segfault-handler` for POSIX
  symbolication.
- Both processes share a single incident `traceId`, so even though the dmps
  live in separate per-process subdirectories, they bundle together.
- Symbol pipeline:
  - `electron-builder` already produces unsigned binaries; configure
    `electron-builder` to emit `.pdb` (Windows) and `dSYM` (macOS) artifacts
    by adding `"win": { "publisherName": "...", "signingHashAlgorithms":
    ["sha256"] }` and ensuring `electron.exe` symbols are downloaded from
    Electron's symbol server during release CI.
  - Add a CI step `sentry-cli upload-dif --org ccsm --project ccsm-electron
    release/` after `make:win` / `make:mac`. Gated on the
    `SENTRY_AUTH_TOKEN` secret being present so OSS forks skip silently.
  - Releases are tagged with `app.getVersion()` already in `init.ts:25`, so
    Sentry can match dmp → release → symbols.

**Interface added/changed**

- electron-builder config addition under `"build": { "afterAllArtifactBuild":
  "scripts/sentry-upload-symbols.cjs" }`.
- New CI secret `SENTRY_AUTH_TOKEN` (release workflow only).
- Existing `SENTRY_DSN` is reused; no new runtime env var.

### §5.5 Structured runtime logs (rolling logfile, rotation, what to capture)

One rolling logfile **per process**, both bundled into "Send last crash":

- frontend: `<userData>/logs/frontend-YYYY-MM-DD.jsonl` (Electron `app.getPath('userData')`).
- backend:  `<runtimeRoot>/logs/backend-YYYY-MM-DD.jsonl`.
- Format: pino-compatible JSONL (frontend uses a pino instance too; daemon
  already does at `daemon/src/index.ts:18-25`).
- Rotation: by date + size. Cap at 7 days × 10 MB per file. Use
  `pino-roll` (small deps cost) or a hand-rolled rotation in the same module.
- What to capture, by level:
  - `info`: subsystem boot/teardown (notify pipeline install, db open, IPC
    register), user-action breadcrumbs (route change, session create).
  - `warn`: every `console.warn` callsite already in the codebase, plus
    deadline overruns, retry exhaustion.
  - `error`: every `console.error` callsite + every Sentry `captureException`.
  - `fatal`: unique to the crash collector.
- Sensitive fields scrubbed at the pino formatter (see §7).

**Interface added/changed**

- New module `electron/log/rolling.ts`:
  - `export function createRollingLogger(opts: { dir: string; baseName: string; level: pino.Level }): pino.Logger`
- daemon: same module path under `daemon/src/log/rolling.ts` (small duplication
  is preferable to a shared package round-trip in v0.3).
- New env var `CCSM_LOG_LEVEL` (defaults to `info`; `debug` at user request).

## §6 DSN + release + symbol pipeline

**DSN topology — DECIDED 2026-05-01**

> One Sentry project (`ccsm`) covers electron-main + renderer + daemon.
> Events are dimensioned by `tags.surface` (`main` | `renderer` | `daemon`)
> set at `Sentry.init({ initialScope: { tags: { surface } } })`. Single DSN
> secret, single issue stream; cross-process correlation by `incidentId` /
> `traceId` already lives in the event payload (§5.3, §10).

**Build-time injection vs runtime**

- Today: `process.env.SENTRY_DSN` consulted at runtime
  (`electron/sentry/init.ts:18`). In `make:win` / `make:mac` builds the env
  is empty → Sentry off → all crashes lost.
- Decision: **build-time injection** is required for the official release
  artifact, but the runtime path stays for forks and developers.
- Implementation:
  - `webpack.DefinePlugin({ 'process.env.SENTRY_DSN': JSON.stringify(process.env.SENTRY_DSN) })`
    for the renderer.
  - `electron-builder.extraMetadata.sentryDsn` plus a tiny `dist/electron/build-info.js`
    generated by `scripts/before-pack.cjs` that exports `{ sentryDsn }`. The
    main-proc init reads `process.env.SENTRY_DSN ?? buildInfo.sentryDsn`.
- Release CI uses a single `SENTRY_DSN` secret; PR / fork builds run the same
  pipeline with the secret absent → DSN baked in as `''` → Sentry stays off
  exactly as today. Zero risk of a fork accidentally shipping our DSN.

**OSS-fork leak prevention**

- The DSN is only ever populated when a workflow on the canonical repo runs
  with the `release` environment that holds the secret. PRs from forks
  cannot read environment secrets per GitHub's default policy.
- A unit test asserts: when `process.env.SENTRY_DSN` is undefined and the
  build-info DSN looks like `''` or a `***REDACTED***` placeholder, `initSentry()`
  must short-circuit (already does — keep regression test).

**Symbol upload**

- New script `scripts/sentry-upload-symbols.cjs` invoked from
  `electron-builder`'s `afterAllArtifactBuild`. Uses `@sentry/cli` with
  `SENTRY_AUTH_TOKEN`. Idempotent + version-keyed.
- Uploads:
  - Renderer source maps from `dist/renderer/*.map` (deleted from the shipped
    asar via existing `"!**/*.map"` filter at `package.json:151`).
  - Electron debug symbols (download from Electron's symbol server during CI
    using `electron/symbols`).
  - Native module pdbs / dSYMs for `better-sqlite3` and `node-pty`.

## §7 PII + consent

**Path scrub**

- In the pino formatter and in Sentry `beforeSend`, run a single replace:
  `s.replaceAll(os.homedir(), '~')`. Cheap, exhaustive.
- Also scrub Windows-style backslash variant; treat both forward- and
  back-slash forms.
- Env redaction: drop everything except an allowlist (`NODE_ENV`,
  `CCSM_*`, `ELECTRON_*`). Never include `PATH`, `HOME`, `USER`, tokens.

**Window title drop**

- `webContents.capturePage()` PNGs are saved with no title metadata.
- Renderer breadcrumbs strip session names from URLs / breadcrumb messages
  before forward; only the sid (ulid) survives.

**Consent — DECIDED 2026-05-01**

> Default = network upload ON (opt-out). No first-run banner in phase 1.
> The Settings toggle is reachable from the Help menu on first crash
> (phase 4 modal links to it). A first-run banner is deferred to phase 4
> so launch-day friction stays at zero.

- Capture-to-disk is **always on**. It is local, scrubbed, and the user
  controls deletion via the directory.
- Network upload (Sentry envelope) is gated by the existing
  `crashReportingOptOut` preference (`electron/prefs/crashReporting.ts:25-35`).
  Default = upload ON; toggle in Settings makes it OFF; takes effect within
  one event via the existing `stateSavedBus` invalidation
  (`electron/prefs/crashReporting.ts:48-52`).
- First-run banner: deferred to phase 4 per the decision above. Settings
  toggle is discoverable via Help menu on first crash.

## §8 "Send last crash" UX

Help menu → "Send last crash report…" opens a small modal:

1. Lists the last 5 incidents from `<crashDir>/` with `(date, surface,
   message-summary)`.
2. Default selection = most recent. Checkboxes to exclude individual files
   from the bundle (e.g. don't ship the screenshot).
3. Two buttons:
   - **Reveal in folder** — opens the incident dir in OS file manager so the
     user can drag-drop it into an email / Slack / GitHub.
   - **Send to maintainer** — only enabled when DSN is configured *and*
     opt-out is not set. Bundles the incident as a single Sentry envelope
     (`Sentry.captureEvent` + `addAttachment` for each file in the dir),
     `flush(5000)`, then shows a confirmation toast with the Sentry event ID
     so the user can quote it in a bug report.
4. Bundle format: zip of the incident dir, named
   `ccsm-crash-<incidentId>.zip`. Includes a top-level `README.txt` with
   "this report contains: X lines of frontend log, Y lines of backend log,
   …" so the user knows what they are sending.

**Interface added/changed**

- New menu item under Help. Menu lives in `electron/lifecycle/appLifecycle.ts`
  today — extend the templated builder.
- New IPC channels:
  - `ccsm:crash:list-incidents` → `IncidentSummary[]`
  - `ccsm:crash:reveal-incident` (main calls `shell.showItemInFolder`)
  - `ccsm:crash:send-incident` → `{ ok: true; eventId } | { ok: false; reason }`

## §9 Daemon crash visibility contract

This is the section that would have saved the 16:18 incident.

**Contract**

> When `ccsm-daemon` exits, electron-main MUST, before any other action,
> attach the following to a fresh incident dir and surface a renderer toast:
>
> 1. `exitCode` (`number | null`) and `signal` (`string | null`) verbatim
>    from the `child.on('exit', ...)` callback.
> 2. The last 200 lines of the daemon's stderr ring buffer.
> 3. The last 200 lines of the daemon's stdout ring buffer.
> 4. The last successful RPC `traceId` known to electron-main (i.e. the most
>    recent envelope it received before `child.on('exit')` fired).
> 5. The daemon's `bootNonce` (delivered on `daemon.hello` reply per
>    `daemon/src/handlers/daemon-hello.ts`).
> 6. Any `<runtimeRoot>/crash/<bootNonce>.json` marker files written by the
>    daemon's `recordAndDie` (these are *additive* — present means the daemon
>    saw the crash itself; absent means it died too fast or natively).
> 7. Wall-clock elapsed since the daemon's last `/healthz` poll.
> 8. **Daemon-boot-crash edge case** — if the rings are empty AND no marker
>    file exists (daemon died so fast that even `recordAndDie` never ran:
>    e.g. ELF/PE load failure, missing native dep, throw in `import` chain),
>    the supervisor still writes `meta.json` with `surface:
>    'daemon-boot-crash'`, `exitCode`, `signal`, `lastHealthzAgoMs: null`,
>    and empty `stderr-tail.txt` / `stdout-tail.txt`. An empty bundle is
>    still a bundle; absence of evidence is itself evidence.

**IPC / file shape**

- Daemon → disk on uncaught exception:
  `<runtimeRoot>/crash/<bootNonce>.json`:
  ```json
  {
    "schemaVersion": 1,
    "bootNonce": "01ARZ3...",
    "ts": "2026-05-01T16:18:03.412Z",
    "surface": "daemon-uncaught",
    "kind": "uncaughtException",
    "message": "...",
    "stack": "...",
    "lastTraceId": "01ARZ3...",
    "logTailRefs": ["backend-2026-05-01.jsonl#L18432-L18632"]
  }
  ```
- Daemon ↔ electron-main: control socket already carries `traceId` per envelope
  (frag-3.4.1). Electron-main's supervisor records each `traceId` from the
  most recent reply into `DaemonChild.lastTraceId` on every successful RPC.
- Electron-main → renderer (new):
  IPC channel `ccsm:daemon-crash` payload
  `{ incidentId: string; exitCode: number | null; signal: string | null;
     bootNonce?: string; markerPresent: boolean }`.
- Renderer wiring: `daemonEventBus.emit('unreachable', ...)` already triggers
  the disconnected banner (`src/lib/daemon-events.ts:53-56`); add a one-shot
  toast "Backend died — view crash report" linking to the incident.

## §10 Local crash directory layout

Single umbrella directory per incident, both processes file under one
incident regardless of which side crashed.

```
%LOCALAPPDATA%\CCSM\crashes\                                 (Windows)
~/Library/Application Support/CCSM/crashes/                  (macOS)
~/.local/share/CCSM/crashes/                                 (Linux)
└── 2026-05-01-1618-<incidentId>/
    ├── meta.json            ← traceId, bootNonce, exitCode/signal,
    │                          electron+app+os version, surface, ts
    ├── frontend.dmp         ← Crashpad dump (electron-main / renderer)
    ├── frontend.log         ← copy of last 5000 lines of frontend logfile
    ├── backend.dmp          ← optional (phase 3, native segfault handler)
    ├── backend.log          ← copy of last 5000 lines of backend logfile
    ├── daemon-marker.json   ← if the daemon's recordAndDie wrote one
    ├── stderr-tail.txt      ← last 200 lines of daemon stderr
    ├── stdout-tail.txt      ← last 200 lines of daemon stdout
    ├── screenshot.png       ← optional, if window was unresponsive
    └── README.txt           ← human-readable summary of the bundle
```

`incidentId` = a Crockford ULID generated at incident creation. Reuses
`ulid` already in deps (`package.json:82`).

`meta.json` schema (versioned, additive):

```json
{
  "schemaVersion": 1,
  "incidentId": "01ARZ3...",
  "ts": "2026-05-01T16:18:03.412Z",
  "surface": "daemon-exit",
  "appVersion": "0.3.0",
  "electronVersion": "41.3.0",
  "os": { "platform": "win32", "release": "10.0.26200", "arch": "x64" },
  "frontend": {
    "lastSentryEventId": "abc123",
    "logFile": "frontend-2026-05-01.jsonl",
    "logRange": "L23001-L28000"
  },
  "backend": {
    "exitCode": null,
    "signal": "SIGSEGV",
    "bootNonce": "01ARZ3...",
    "lastTraceId": "01ARZ3...",
    "lastHealthzAgoMs": 8412,
    "markerPresent": true
  }
}
```

Retention: keep last 20 incidents OR 30 days, whichever is larger. Pruner
runs at electron-main boot. Pruner is best-effort — swallow per-entry errors
and log to the rolling logfile rather than aborting the boot path.

**`_dmp-staging/` concurrency**

Crashpad serializes its own minidump writes within a single `crashpad_handler`
process (Crashpad's `Settings::ClientID` + the staging dir is single-tenant
by design). However, two near-simultaneous crashes (e.g. renderer + GPU
within the same flush window) can both land dumps in `_dmp-staging/` before
the collector consumes them. The collector therefore:

- enumerates `_dmp-staging/*.dmp` by mtime ascending on every incident
  ingest, claims each file by `rename`-into-incident-dir (atomic on NTFS /
  POSIX), and skips any that lose the rename race;
- writes a per-PID subdir `_dmp-staging/<crashpadPid>/` if a future Electron
  exposes the crashpad child PID, so the rename target is unambiguous;
- otherwise relies on Crashpad's own filename uniqueness (`<uuid>.dmp`).

This is a phase-1 implementation detail captured here so the collector
author does not assume single-writer semantics.

## §11 Rollout phases

Each phase ships independently. Phase 1 alone closes the 16:18-style
"nothing on disk" gap.

### Phase 1 — recoverable artifacts on every crash, no DSN needed (3 PRs)

> After phase 1 we always have a local incident dir for both frontend and
> backend crashes, even with `SENTRY_DSN` empty. This is the user-blocking
> gap from today's incident.

- electron-main `crash/collector.ts` + `crashReporter.start({uploadToServer: false})`
  + replace `console.error`-only `uncaught/unhandledRejection` handlers.
- daemon `crash/handlers.ts` + marker-file write + `process.exit(70)`.
- electron-main supervisor stderr ring buffer + `child.on('exit')` →
  `recordIncident({ surface: 'daemon-exit' })`.
- Smoke tests: throw from a hidden IPC, kill -9 the daemon child, confirm
  incident dir contents. Note: `kill -9` (SIGKILL) deliberately exercises
  the **supervisor-side** capture path (exit-code + stderr ring) — it does
  *not* trigger the daemon's own `recordAndDie`, which is correct. A
  separate smoke test (throw inside a daemon RPC handler) covers the
  daemon-side `recordAndDie` → marker-file → `process.exit(70)` path.

### Phase 2 — Sentry routing for both processes, build-time DSN injection (2 PRs)

> Now operator-configured forks and our official release ship crashes to
> Sentry; OSS forks stay opt-in.

- `webpack.DefinePlugin` + `before-pack.cjs` build-info DSN inject.
- daemon `@sentry/node` init reading forwarded env.
- Release CI secret wiring + regression test for empty-DSN case.

### Phase 3 — symbol pipeline + native daemon segfaults (2 PRs)

> Stack traces in Sentry become readable; native crashes in the daemon stop
> being silent.

- `scripts/sentry-upload-symbols.cjs` + electron-builder hook.
- Optional `node-segfault-handler` in daemon for POSIX.
- Smoke: trigger a known native crash in `better-sqlite3`, verify symbolicated
  stack in Sentry test project.

### Phase 4 — "Send last crash" UX + first-run consent banner (1-2 PRs)

> User-visible loop: see a crash → one click → bundle reaches maintainer.

- Help menu entry, modal, IPC channels, zip bundling.
- First-run consent (defaults to ON, settings link).
- Unresponsive-window screenshot capture.

### Phase 5 — log forwarding + rolling files everywhere (1 PR)

> Steady-state: every `console.*` call in main + renderer is captured even
> when no crash happens, so we can debug warm bugs.

- `electron/log/rolling.ts` + redirect existing console output.
- daemon already uses pino → just add the rolling sink.
- Renderer log forwarder (frag-6-7 §6.6.2 already speccs the channel; here
  we wire its sink to the rolling file).

## §12 Open questions for user

All previously-open questions resolved 2026-05-01:

- ~~Q1. Default-on vs first-run consent for Sentry network upload?~~
  **Locked** — default-on opt-out, no first-run banner in phase 1, banner
  deferred to phase 4. See §7.
- ~~Q2. One Sentry project for both processes, or two?~~
  **Locked** — one project, dimensioned by `tags.surface`. See §6.
- ~~Q3. Bundle daemon `pino` into the frontend logfile via IPC, or keep two
  separate files?~~ **Manager-locked** — two files. The daemon may crash
  before any IPC opens, so its logs must land on disk independently of the
  frontend transport. See §5.5.

No remaining direction-affecting questions for the user.
