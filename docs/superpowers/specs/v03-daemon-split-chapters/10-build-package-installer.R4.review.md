# 10 — Build, Package, Installer — R4 (Testability + Ship-Gate Coverage)

Angle: chapter 10 owns ship-gate (d). R4 audits installer testability + native-module test coverage + signing test coverage.

## P0 — Native module test plan does not exist for the per-OS sea bundle

§2 ships native `.node` files alongside the executable. CI matrix §6 builds 6 daemon variants (3 OS × 2 arch). There is no test in chapter 12 that runs ON each of those 6 variants asserting `Database(":memory:")` and `pty.spawn(...)` succeed when LOADED VIA `native-loader.ts` (i.e., from the actual `process.execPath`-relative path).

Chapter 12 §2 has `db/migrations.spec.ts` running against `:memory:` — but that runs in the Node test runner via the npm-installed `better-sqlite3`, NOT via the sidecar-loaded one. The two are different binaries (test uses prebuilt-via-npm; production uses sea-adjacent `.node`). A regression in the build pipeline that ships a wrong-arch or wrong-ABI `.node` won't fire ANY test in chapter 12.

Add `tools/sea-smoke/` script run in `e2e-installer-*` jobs:
- Run the actual built `ccsm-daemon` binary
- Wait for Supervisor `/healthz` 200
- Connect via Hello
- Create a session that spawns `bash -c 'echo ok'`
- Assert the PTY emitted "ok"
- Stop daemon

This is the smoke that proves both `node-pty` and `better-sqlite3` are correctly sidecar-loaded. Currently the only test of the actual built binary is ship-gate (d) which is Win-only. mac/linux can ship a broken `.node` and CI is green.

P0 because the CI matrix §6 `build-daemon-*` jobs produce binaries that are never exercised end-to-end except via Win 11 25H2 ship-gate (d) — mac/linux daemons can ship broken without any failed test.

## P0 — Code signing has no verification test

§3 specifies `signtool` / `codesign` / `debsigs` commands. Nothing in chapter 12 verifies after signing that the binary actually IS signed and IS valid. Standard test:
- Win: `Get-AuthenticodeSignature .\ccsm-daemon.exe` — assert Status==Valid
- mac: `codesign --verify --deep --strict ccsm-daemon` — assert exit 0; `spctl --assess --type execute ccsm-daemon` — assert "accepted"
- linux: `dpkg-sig --verify ccsm.deb` — assert exit 0; `rpm -K ccsm.rpm` — assert "OK"

Add `tools/verify-signing.{sh,ps1}` invoked in the `package-*` jobs after signing. Also verify notarization with `stapler validate ccsm.pkg` on mac. Without these, a misconfigured signing step ships an unsigned binary that Windows SmartScreen / macOS Gatekeeper blocks at install time on user machines — caught only in production.

P0 because signing verification is a 5-line script per OS and the absence will burn users on day 1 of dogfood.

## P0 — Installer round-trip test (gate (d)) requires self-hosted Win 11 25H2 VM that has no provisioning recipe

Chapter 11 §6 specifies `runs-on: self-hosted-win11-25h2-vm`. Chapter 10 §6 specifies `e2e-win-installer-vm` runs on `self-hosted Win 11 25H2`. Chapter 12 §4.4 says "Self-hosted runner with 1-hour budget" for soak; the installer round-trip script says "Snapshotted to a clean state before each run" via `Invoke-Snapshot-Restore "win11-25h2-clean"`.

There is no spec for:
- Where the VM image comes from (download URL, ISO, license)
- Who provisions the runner (operator? CI ops? GitHub Actions self-hosted runner setup steps)
- How the snapshot is created and updated (when 25H2 patches drop monthly, who refreshes)
- The Hyper-V / VMware / cloud VM choice
- How CI calls Invoke-Snapshot-Restore (custom Hyper-V cmdlet? Specific tool?)
- Network connectivity from the VM to GitHub (proxy? direct?)

**This is an ops dependency that gates phase 11(d) which gates ship.** A spec that mentions self-hosted runners without specifying their existence is hand-waving.

P0 because ship-gate (d) is unimplementable until someone provisions this runner; spec should either pin the procedure (in this chapter, since it owns gate (d)) or descope to "tested manually on a single laptop, results posted to release notes."

## P1 — Installer step 7 "/healthz returns 200 within 10s" lacks failure-mode test

§5 step 7: "Wait up to 10 s for `GET /healthz` on Supervisor UDS to return 200."

What if it doesn't? Spec doesn't say. Installer rolls back? Installer fails? Installer succeeds with a warning? Pin behavior. Then add a test variant: install a deliberately-broken daemon (e.g., binary that exits 1 on start), assert installer fails (or rolls back) cleanly + uninstall is invocable + leaves no residue. Without this, a half-installed state is a real user scenario with undefined behavior.

## P1 — Uninstaller step 4 "prompt user 'remove user data?'" cannot be MSI-silent

§5 step 4: "Prompt user 'remove user data?'". MSI uninstalls run via `msiexec /x ... /qn` (silent) routinely (enterprise GPO; ship-gate (d) script line `Start-Process -Wait msiexec -ArgumentList "/x ..."`). A prompt in silent mode either blocks indefinitely (bad) or defaults silently. The ship-gate (d) script doesn't pass the user-data-removal flag. Spec: pin the silent default (default: keep), pin the public property name (`REMOVEUSERDATA=1`) for the override, and have ship-gate (d) test BOTH variants (default: state remains; with `REMOVEUSERDATA=1`: state is gone). Without this, ship-gate (d) doesn't actually verify the "remove user data" path works.

## P1 — Cross-arch (arm64) build matrix has no native test runner

§6 matrix lists `darwin-arm64`, `linux-arm64`, `win-arm64`. GitHub-hosted runners for arm64 mac exist (macos-14-arm64 / macos-14 is universal); for linux/win arm64 there are limited options. The chapter doesn't say where these run. If they cross-compile on x64 runners, the `.node` files are emit-only with no native execution — meaning the smoke test (suggested above) cannot run on the actual arm64 binary in CI. Pin: which arm64 builds get smoke-tested in CI vs are cross-built-only ("test on hardware before ship; document").

## P1 — Mac pkg uninstaller is a separate `.command` script

§5.2: "Uninstaller: a separate `ccsm-uninstall.command` script in `/Library/Application Support/ccsm/`."

Mac users do not know to run a script from a deep filesystem path. There is no test that running this script cleanly removes everything. Add `installer-roundtrip.sh` for mac (parallel to the .ps1 for win) running install → smoke → uninstall via the script → residue check. Currently chapter 12 §4.4 mentions "Mac/linux equivalents written in parallel" — pin existence, paths, and what they verify.

## P1 — `MUST-SPIKE [msi-service-install-25h2]` fallback is `New-Service` from custom action; no test for the fallback

If WiX `<ServiceInstall>` fails the spike, fallback is custom action with `New-Service` + SDDL. Custom actions are notoriously fragile (32 vs 64 bit; deferred vs immediate; rollback). Spec doesn't address fallback testing — if we adopt the fallback, the existing installer-roundtrip.ps1 may not cover it. Add: "if fallback adopted, installer-roundtrip.ps1 includes additional checks: `sc qfailure ccsm-daemon`, `sc qsidtype ccsm-daemon` to verify the SDDL was applied."

## P2 — Code signing secrets management

CI signing requires secrets (cert + password). §6 says "uses encrypted secrets" but does not pin: where stored (GH Actions secrets? OIDC?), rotation cadence, who has access. Operational risk; flag for ops.

## Summary

P0 count: 3 (no native-module smoke on per-OS sea binary; no signing verification; ship-gate (d) Win 11 25H2 runner is unprovisioned)
P1 count: 5
P2 count: 1

Most-severe one-liner: **Ship-gate (d) is gated on a self-hosted Win 11 25H2 VM runner with no provisioning recipe — phase 10 cannot complete until someone provisions infra the spec doesn't even mention.**
