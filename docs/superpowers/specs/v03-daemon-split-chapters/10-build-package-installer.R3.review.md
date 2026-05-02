# R3 review — 10-build-package-installer

## P1-R3-10-01 — Installer post-install verification only checks Supervisor /healthz, not actual data plane

§5 step 7: "Wait up to 10 s for `GET /healthz` on Supervisor UDS to return 200." Per chapter 03 §7, Supervisor returns 200 once "startup step 5 (per chapter 02 §3) completes" — which DOES include Listener A bind. So technically adequate.

But §5 does not specify what happens when /healthz returns NOT 200 within 10s (timeout). R3 angle 9: "service registers OK but fails to start (port collision, permission denied, binary missing): installer must surface this clearly, not silently leave a non-functional service."

Currently the spec implies the installer just proceeds (no error path). Spec MUST add: "On /healthz timeout, installer reads `state/crash-raw.ndjson`, surfaces the most recent fatal entry's `summary` to the user via the installer UI, AND fails the install (MSI rollback / pkg postinstall non-zero / dpkg failure), so the user sees a real error rather than a half-installed service."

Cross-reference to R3-02-01.

## P1-R3-10-02 — Uninstall residue check does not include Electron per-user state

§5.1 lists residue checks for `%ProgramFiles%\ccsm`, `%ProgramData%\ccsm`, service registration, scheduled tasks, registry. Missing: per-user `%APPDATA%\ccsm-electron\`. This stays after uninstall forever per user. Add to the residue checklist OR explicitly state "per-user Electron state is intentionally retained for re-install convenience" — either is defensible, but pick.

Cross-reference R3-07-04.

## P1-R3-10-03 — No installer log / observability path

R3 angle 20. Where do installer-side errors go?

- §5.1 Win MSI: log via `/l*v C:\install\install.log` — chapter 12 §4.4 ship-gate (d) script does this. But §5 (the spec's installer responsibilities list) does not require the log path. Spec should mandate "MSI log path predictable: `%PROGRAMDATA%\ccsm\logs\install-<ts>.log` so post-install debugging has a known location."
- §5.2 mac pkg: no log path specified at all. Apple convention is `/var/log/install.log`; spec should reference.
- §5.3 linux: dpkg/rpm output goes to apt/dnf logs; OK. Spec should mention.

Without this, ship-gate (d) failures on customer machines are undebuggable.

## P1-R3-10-04 — Service recovery actions specified for Win only

Chapter 02 §2.1 spec'd Win recovery actions (5s, 30s, no command). §2.2 mac launchd `KeepAlive={Crashed=true}` — restarts on crash but no backoff. §2.3 linux `Restart=on-failure RestartSec=5s` — restarts but no backoff cap. Linux `Restart=` does NOT include a max-attempts gate (`StartLimitBurst` / `StartLimitIntervalSec`); a crash loop will burn CPU forever. Spec should add `StartLimitBurst=5 StartLimitIntervalSec=60s` to the systemd unit so a crash loop eventually gives up and exposes itself in `systemctl status`.

This is a chapter 02 issue; calling out here because the installer is what writes the unit file.

## P2-R3-10-05 — ship-gate (d) does not exercise post-install log surface

Chapter 12 §4.4 ship-gate (d) tests install + service + smoke + uninstall. It does NOT test:
- Install with a deliberately broken pre-condition (port 80 occupied by IIS) → installer surfaces the right error.
- Install on a machine where `%PROGRAMDATA%` ACL is hardened → installer surfaces the failure.

These are the realistic enterprise-IT failure modes ship-gate (d) is supposed to catch. Recommend adding "negative-path installer tests" to the ship-gate. NOT P0 because the happy path test is the main bar.

## NO FINDING — sea + native loader strategy

§1-2 are well-specified; the MUST-SPIKE register handles unknowns.

## NO FINDING — code signing per OS

§3 covers signing/notarization adequately for v0.3.
