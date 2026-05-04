# tools/sea-smoke

Post-install daemon end-to-end smoke. Spec: `docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md` chapter 10 §7. Task T7.8 (#79).

## What it does

Runs the **actual installed `ccsm-daemon` binary** placed by the real per-OS installer (msi / pkg / deb / rpm) — NOT a `node bundle.js` invocation. That is the entire point of this script: it proves the sea binary, the per-OS service registration, and the Listener A descriptor wiring all work end-to-end against the same artefacts that ship to users.

Step list (verbatim from spec ch10 §7):

1. Start the OS service (or reuse the installer-started service):
   - linux: `systemctl start ccsm-daemon`
   - mac: `launchctl kickstart system/com.ccsm.daemon`
   - win: `Start-Service ccsm-daemon`
2. Poll Supervisor `/healthz` (per-OS UDS / named-pipe path) for HTTP 200 within 10 s.
3. Read `listener-a.json`, dial Listener A, call `Hello` — assert `proto_version` matches.
4. `CreateSession({ claude_args: ["echo", "ok"] })` — assert returned `Session.id` non-empty.
5. Subscribe to `PtyService.Attach({ session_id })` — assert at least one delta arrives within 5 s containing the literal bytes `ok`.
6. Stop the daemon — assert process exits within 5 s.
7. Exit non-zero on any step failure; capture per-OS service-manager log on failure (same capture rule as ch10 §5 step 7).

## Invocation

```bash
node --import tsx tools/sea-smoke/main.ts
```

(or `pnpm --filter @ccsm/sea-smoke run smoke`)

The CI `.github/workflows/ci.yml` `sea-smoke` matrix job runs this AFTER each per-OS installer round-trip job has placed the daemon and registered the service. See spec ch10 §6 for the matrix shape.

## Layout

- `main.ts` — orchestrator (steps 1–6 + step 7 failure path)
- `lib/healthz-wait.ts` — `/healthz` poller (10 s budget, 250 ms interval)
- `lib/service-log.ts` — per-OS service-manager log dump on failure (`journalctl` / `log show` / `Get-WinEvent`)

Service-manager commands and `/healthz` capture command are sourced from the locked spec ch10 §5 step 7 strings (mirrored in `packages/daemon/build/install/post-install-healthz.{sh,ps1}`).

## Why a separate workspace package vs inlining in `tools/`

Two reasons:

1. The smoke needs typed Connect-RPC clients from `@ccsm/proto`. A standalone script under `tools/` cannot resolve workspace deps without a `package.json` of its own.
2. The smoke is a sea-binary candidate (per spec ch10 §7 the script is "reused by the manual mac/linux pre-tag installer smoke and by the manual arm64 smoke step"). Future packaging into a single-file binary needs a per-package build boundary.

Lives under `tools/` (not `packages/`) because it does not ship to end users — it is a CI / pre-tag verification tool only.
