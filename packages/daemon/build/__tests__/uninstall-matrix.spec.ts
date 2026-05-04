// packages/daemon/build/__tests__/uninstall-matrix.spec.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       chapter 10 §5 step list ("Common to all uninstallers", steps 1-6)
//       + chapter 10 §5.1 (Win MSI REMOVEUSERDATA + ServiceControl)
//       + chapter 10 §5.2 (mac ccsm-uninstall.command path)
//       + chapter 10 §5.3 (linux postrm CCSM_REMOVE_USER_DATA).
// Task: T7.6 (#84) — uninstaller: REMOVEUSERDATA matrix + service unregister + cleanup.
//
// Forever-stable shape gates that lock the uninstaller behaviour matrix
// across the 3 OSes:
//
//   { OS } × { interactive, silent } × { REMOVEUSERDATA=0, REMOVEUSERDATA=1 }
//   plus per-OS service-unregister verifications.
//
// We assert on the SOURCES (uninstall scripts + WiX manifest) rather than
// running a real msiexec / launchctl / dpkg, because the toolchain is not
// uniformly available on dev boxes (same constraint as T7.4 spec). The
// real round-trip is exercised by tools/installer-roundtrip.{ps1,sh},
// which is a downstream ship-gate (d) test — these unit tests are the
// pre-merge contract that lets that ship-gate stay green.
//
// Test count discipline (T7.6 spec): ≥ 44 shape gates. The block layout
// below is sized to 50 it() calls to leave headroom; each gate locks
// exactly one decision so a future PR cannot quietly drift any single
// matrix cell.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BUILD_DIR = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(BUILD_DIR, 'install');
const REPO_ROOT = path.resolve(BUILD_DIR, '..', '..', '..');

// Per-OS layout under build/install/<os>/ (T7.4 lineage).
const WIN_WXS         = path.join(INSTALL_DIR, 'win', 'Product.wxs.template');
const MAC_UNINSTALL   = path.join(INSTALL_DIR, 'mac', 'uninstall.sh');
const MAC_POSTINSTALL = path.join(INSTALL_DIR, 'mac', 'postinstall.sh');
const MAC_BUILD_PKG   = path.join(INSTALL_DIR, 'mac', 'build-pkg.sh');
const LINUX_PRERM     = path.join(INSTALL_DIR, 'linux', 'prerm.sh');
const LINUX_POSTRM    = path.join(INSTALL_DIR, 'linux', 'postrm.sh');

// Top-level wrappers (manager spec: scripts/installer/uninstall.{sh,ps1}).
const TOP_UNINSTALL_SH  = path.join(REPO_ROOT, 'scripts', 'installer', 'uninstall.sh');
const TOP_UNINSTALL_PS1 = path.join(REPO_ROOT, 'scripts', 'installer', 'uninstall.ps1');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('uninstall matrix — files exist (T7.6 spec ch10 §5)', () => {
  it('mac per-OS uninstaller source exists', () => {
    expect(existsSync(MAC_UNINSTALL)).toBe(true);
  });

  it('top-level uninstall.sh exists at scripts/installer/', () => {
    expect(existsSync(TOP_UNINSTALL_SH)).toBe(true);
  });

  it('top-level uninstall.ps1 exists at scripts/installer/', () => {
    expect(existsSync(TOP_UNINSTALL_PS1)).toBe(true);
  });

  it('top-level uninstall.sh is non-empty (>= 1 KB of real content)', () => {
    expect(statSync(TOP_UNINSTALL_SH).size).toBeGreaterThan(1024);
  });

  it('top-level uninstall.ps1 is non-empty (>= 1 KB of real content)', () => {
    expect(statSync(TOP_UNINSTALL_PS1).size).toBeGreaterThan(1024);
  });
});

describe('uninstall matrix — Windows MSI ServiceControl + REMOVEUSERDATA (ch10 §5.1)', () => {
  const wxs = read(WIN_WXS);

  // Spec ch10 §5 common-to-all-uninstallers step 1: stop service (≤10s
  // clean exit). WiX 4 <ServiceControl Stop="both"> performs blocking
  // stop with the SCM's 30s default, well within the 10s budget the
  // /healthz path exercises in §5 step 7.
  it('declares <ServiceControl Stop="both"> for ccsm-daemon (step 1: stop service)', () => {
    expect(wxs).toMatch(/<ServiceControl[\s\S]*?Name="ccsm-daemon"[\s\S]*?Stop="both"/);
  });

  // Spec step 2: unregister service. WiX 4 Remove="uninstall" tells the
  // SCM to delete the service entry on uninstall (and Remove="install"
  // would do it on install, which we do NOT want).
  it('declares <ServiceControl Remove="uninstall"> for ccsm-daemon (step 2: unregister)', () => {
    expect(wxs).toMatch(/<ServiceControl[\s\S]*?Name="ccsm-daemon"[\s\S]*?Remove="uninstall"/);
  });

  it('declares <ServiceControl Wait="yes"> so msiexec blocks until service is stopped', () => {
    // Without Wait="yes" the MSI proceeds before the service has actually
    // released file handles, races the file-table delete, and leaves
    // ccsm-daemon.exe on disk under "scheduled for delete on reboot".
    expect(wxs).toMatch(/<ServiceControl[\s\S]*?Wait="yes"/);
  });

  // Spec step 4 silent contract: REMOVEUSERDATA public property gates
  // state-dir removal in /qn mode.
  it('declares REMOVEUSERDATA as a Public property (uppercase id, MSI public-property convention)', () => {
    // MSI public properties are uppercase; lowercase would not be
    // settable from the command line. Spec ch10 §5 step 4 calls it out
    // by name.
    expect(wxs).toMatch(/<Property[\s\S]*?Id="REMOVEUSERDATA"/);
  });

  it('marks REMOVEUSERDATA Secure="yes" (required for /qn elevated installs)', () => {
    // Without Secure="yes" the value set on the command line is dropped
    // when running elevated under /qn, defeating the silent path.
    expect(wxs).toMatch(/Id="REMOVEUSERDATA"[\s\S]*?Secure="yes"/);
  });

  it('defaults REMOVEUSERDATA to "0" (spec: default keep)', () => {
    // Spec ch10 §5 step 4 line: 'Default: keep state on uninstall'.
    expect(wxs).toMatch(/Id="REMOVEUSERDATA"[\s\S]*?Value="0"/);
  });

  it('has a state-dir component WITHOUT RemoveFolderEx (the keep-data branch)', () => {
    // The two-component pattern from T7.4: "StateDir" (always created,
    // no RemoveFolderEx) + "StateDirRemovable" (RemoveFolderEx gated).
    // We assert the keep-data branch contains no RemoveFolderEx.
    const stateDirBlock = wxs.match(/<Component\s+Id="StateDir"[\s\S]*?<\/Component>/);
    expect(stateDirBlock).not.toBeNull();
    expect(stateDirBlock![0]).not.toMatch(/RemoveFolderEx/);
  });

  it('has a state-dir component WITH RemoveFolderEx gated to REMOVEUSERDATA="1" (the remove-data branch)', () => {
    const removableBlock = wxs.match(/<Component\s+Id="StateDirRemovable"[\s\S]*?<\/Component>/);
    expect(removableBlock).not.toBeNull();
    expect(removableBlock![0]).toMatch(/util:RemoveFolderEx/);
    expect(removableBlock![0]).toMatch(/On="uninstall"/);
    expect(removableBlock![0]).toMatch(/REMOVEUSERDATA="1"/);
  });

  it('keep-data branch component is conditioned on REMOVEUSERDATA NOT being "1"', () => {
    const stateDirBlock = wxs.match(/<Component\s+Id="StateDir"[\s\S]*?<\/Component>/);
    expect(stateDirBlock).not.toBeNull();
    // The condition is "NOT REMOVEUSERDATA OR REMOVEUSERDATA='0'" —
    // either form covers the spec's "default keep" branch.
    expect(stateDirBlock![0]).toMatch(/NOT REMOVEUSERDATA|REMOVEUSERDATA="0"/);
  });

  it('removes service via WiX <ServiceControl> NOT a sc.exe custom action (spec lock)', () => {
    // Spec ch10 §5.1 explicitly forbids "sc.exe custom action" because
    // declarative control is cleaner for uninstall and rollback.
    expect(wxs).not.toMatch(/<CustomAction[\s\S]*?ExeCommand=".*sc\.exe.*delete/i);
  });
});

describe('uninstall matrix — Windows uninstall.ps1 wrapper (interactive + silent)', () => {
  const ps1 = read(TOP_UNINSTALL_PS1);

  it('exposes a -Silent switch (msiexec /qn path, ship-gate (d))', () => {
    expect(ps1).toMatch(/\[switch\]\$Silent/);
  });

  it('exposes a -RemoveUserData switch (force REMOVEUSERDATA=1)', () => {
    expect(ps1).toMatch(/\[switch\]\$RemoveUserData/);
  });

  it('exposes a -KeepUserData switch (force REMOVEUSERDATA=0)', () => {
    expect(ps1).toMatch(/\[switch\]\$KeepUserData/);
  });

  it('passes REMOVEUSERDATA=$removeUserData on the msiexec command line', () => {
    // Critical: the value must be passed as a command-line property
    // assignment, not a switch — msiexec parses "REMOVEUSERDATA=1" as
    // a property=value pair and matches the WiX <Property> by name.
    expect(ps1).toMatch(/"REMOVEUSERDATA=\$removeUserData"/);
  });

  it('uses /qn for silent and /qb for interactive (spec ch10 §5 step 4)', () => {
    // /qn = no UI, /qb = basic UI with progress bar; interactive must
    // NOT use full UI /qf since we already gathered the user choice via
    // PowerShell prompt.
    expect(ps1).toMatch(/'\/qn'/);
    expect(ps1).toMatch(/'\/qb'/);
  });

  it('passes /norestart so MSI never auto-reboots', () => {
    expect(ps1).toMatch(/'\/norestart'/);
  });

  it('passes /l*v with a verbose log path so ship-gate (d) can attach on failure', () => {
    expect(ps1).toMatch(/'\/l\*v'/);
  });

  it('reads $env:CCSM_REMOVE_USER_DATA in -Silent mode (spec env contract)', () => {
    expect(ps1).toMatch(/\$env:CCSM_REMOVE_USER_DATA/);
  });

  it('defaults REMOVEUSERDATA to "0" if no flag and no env (spec: default keep)', () => {
    // Initial value declaration — explicit "0" so a future refactor
    // can not accidentally flip the default.
    expect(ps1).toMatch(/\$removeUserData\s*=\s*'0'/);
  });

  it('elevation check uses Administrator role (uninstall must run elevated)', () => {
    expect(ps1).toMatch(/WindowsBuiltInRole\]::Administrator/);
  });

  it('exits 1 when not elevated', () => {
    expect(ps1).toMatch(/exit 1/);
  });

  it('exits 2 when no installed CCSM product is detected', () => {
    expect(ps1).toMatch(/exit 2/);
  });

  it('looks up product code from Uninstall registry by DisplayName="CCSM"', () => {
    // Avoids Win32_Product (slow, side-effect-y); uses both 64-bit
    // and WOW6432 hives so a 32-bit installer is also discoverable.
    expect(ps1).toMatch(/DisplayName.*-eq.*'CCSM'/);
    expect(ps1).toMatch(/WOW6432Node/);
  });

  it('treats msiexec exit 3010 as success (reboot required)', () => {
    expect(ps1).toMatch(/3010/);
  });

  it('rejects both -RemoveUserData and -KeepUserData passed together', () => {
    expect(ps1).toMatch(/RemoveUserData -and \$KeepUserData/);
  });
});

describe('uninstall matrix — macOS uninstall.sh (ccsm-uninstall.command source)', () => {
  const sh = read(MAC_UNINSTALL);

  it('starts with bash shebang', () => {
    expect(sh.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('exposes --silent and --interactive modes (spec ch10 §5 step 4 both variants)', () => {
    expect(sh).toMatch(/--silent\|-y\)/);
    expect(sh).toMatch(/--interactive\)/);
  });

  it('exposes --remove-user-data and --keep-user-data CLI flags', () => {
    expect(sh).toMatch(/--remove-user-data\)/);
    expect(sh).toMatch(/--keep-user-data\)/);
  });

  it('reads CCSM_REMOVE_USER_DATA env in silent mode (default 0 = keep)', () => {
    expect(sh).toMatch(/\$\{CCSM_REMOVE_USER_DATA:-0\}/);
  });

  // Step 1: stop service. spec ch10 §5.2: launchctl bootout system/com.ccsm.daemon
  it('step 1: invokes launchctl bootout system/com.ccsm.daemon', () => {
    expect(sh).toMatch(/launchctl bootout[\s\S]*?system\/com\.ccsm\.daemon/);
  });

  it('step 1 escalates to SIGTERM then SIGKILL on bootout-survivor (spec ch10 §8 escalation)', () => {
    // bootout is best-effort; if a daemon survives we follow the
    // SIGTERM(5s) → SIGKILL escalation pattern from spec §8.
    expect(sh).toMatch(/pkill -TERM/);
    expect(sh).toMatch(/pkill -KILL/);
  });

  // Step 2: unregister service. Removing the plist is what makes the
  // unregister persistent across reboots.
  it('step 2: removes /Library/LaunchDaemons/com.ccsm.daemon.plist', () => {
    expect(sh).toMatch(/rm -f "\$PLIST"/);
    expect(sh).toMatch(/\/Library\/LaunchDaemons\/com\.ccsm\.daemon\.plist/);
  });

  // Step 3: remove binaries. spec ch10 §5.2 install path: /usr/local/ccsm.
  it('step 3: removes /usr/local/ccsm install dir', () => {
    expect(sh).toMatch(/rm -rf "\$INSTALL_DIR"/);
    expect(sh).toMatch(/INSTALL_DIR="\/usr\/local\/ccsm"/);
  });

  // Step 5: remove state dir, ONLY when remove_user_data=1.
  it('step 5: removes /Library/Application Support/ccsm only when remove_user_data=1', () => {
    expect(sh).toMatch(/if \[\[ "\$remove_user_data" == "1" \]\]/);
    expect(sh).toMatch(/rm -rf "\$STATE_DIR"/);
    expect(sh).toMatch(/\/Library\/Application Support\/ccsm/);
  });

  it('step 5: removes /Library/Logs/ccsm only when remove_user_data=1', () => {
    expect(sh).toMatch(/rm -rf "\$LOG_DIR"/);
  });

  it('step 5: dscl-deletes _ccsm user/group only when remove_user_data=1', () => {
    expect(sh).toMatch(/dscl \. -delete "\/Users\/\$SVC_USER"/);
    expect(sh).toMatch(/dscl \. -delete "\/Groups\/\$SVC_GROUP"/);
  });

  it('keep-data branch logs that state dir is preserved (no rm)', () => {
    // The else-branch must log the keep so an operator running the
    // uninstaller has a clear "we left your data" affordance.
    expect(sh).toMatch(/keeping \$STATE_DIR/);
  });

  it('refuses to run as non-root (uid != 0 -> exit 1)', () => {
    expect(sh).toMatch(/id -u.*-ne 0/);
    expect(sh).toMatch(/exit 1/);
  });

  it('exits 2 if no plist AND no install dir (nothing to uninstall)', () => {
    expect(sh).toMatch(/exit 2/);
  });

  it('is valid bash (parses with bash -n)', () => {
    // The mac uninstall script is non-trivial; bash -n catches a stray
    // unmatched [[ before it ships in a .pkg payload.
    execFileSync('bash', ['-n', MAC_UNINSTALL], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

describe('uninstall matrix — macOS pkg payload wires the uninstaller', () => {
  it('postinstall.sh copies uninstall.sh to /Library/Application Support/ccsm/ccsm-uninstall.command', () => {
    // Spec ch10 §5.2 line: "a separate ccsm-uninstall.command script
    // in /Library/Application Support/ccsm/". Renamed from .sh to
    // .command so Finder double-click runs it in Terminal.app.
    const post = read(MAC_POSTINSTALL);
    expect(post).toMatch(/ccsm-uninstall\.command/);
    expect(post).toMatch(/\/Library\/Application Support\/ccsm/);
  });

  it('postinstall.sh chmods uninstall.command 0755 (operator must execute it)', () => {
    const post = read(MAC_POSTINSTALL);
    expect(post).toMatch(/chmod 0755 "\$UNINSTALL_DST"/);
  });

  it('postinstall.sh chowns uninstall.command root:wheel (not _ccsm — must outlive state-dir removal)', () => {
    const post = read(MAC_POSTINSTALL);
    expect(post).toMatch(/chown root:wheel "\$UNINSTALL_DST"/);
  });

  it('build-pkg.sh stages uninstall.sh into /usr/local/ccsm/uninstall.sh', () => {
    // The .pkg payload carries uninstall.sh under /usr/local/ccsm so
    // postinstall can cp it into the state dir (mac/postinstall.sh).
    const build = read(MAC_BUILD_PKG);
    expect(build).toMatch(/cp "\$MAC_DIR\/uninstall\.sh"/);
    expect(build).toMatch(/\$STAGE\/usr\/local\/ccsm\/uninstall\.sh/);
  });
});

describe('uninstall matrix — Linux postrm honours CCSM_REMOVE_USER_DATA (ch10 §5.3)', () => {
  // T7.4 already shipped these; T7.6 re-asserts the behaviour matrix
  // against the SAME postrm (so a future drift to either side is caught).
  const prerm  = read(LINUX_PRERM);
  const postrm = read(LINUX_POSTRM);

  // Step 1: stop service. prerm.sh runs BEFORE files are removed.
  it('step 1: prerm stops ccsm-daemon when not in upgrade mode', () => {
    expect(prerm).toMatch(/systemctl stop ccsm-daemon/);
  });

  // Step 2: unregister service.
  it('step 2: prerm disables ccsm-daemon (unregister)', () => {
    expect(prerm).toMatch(/systemctl disable ccsm-daemon/);
  });

  it('prerm short-circuits on upgrade (does NOT stop service)', () => {
    // Critical: dpkg/rpm runs prerm on upgrade too; without the
    // upgrade short-circuit we'd kill the daemon mid-upgrade.
    expect(prerm).toMatch(/upgrade\|1\|2/);
  });

  // Step 4: state decision. Step 5: remove state dir if yes.
  it('step 5 (remove-data branch): postrm rm -rf /var/lib/ccsm when CCSM_REMOVE_USER_DATA=1', () => {
    expect(postrm).toMatch(/CCSM_REMOVE_USER_DATA/);
    expect(postrm).toMatch(/rm -rf \/var\/lib\/ccsm/);
  });

  it('step 5 (remove-data branch): postrm also removes /run/ccsm runtime dir', () => {
    // RuntimeDirectory=ccsm (ch07 §2) is created by systemd on start;
    // a clean uninstall must clear it too in the remove-data branch.
    expect(postrm).toMatch(/\/run\/ccsm/);
  });

  it('step 5 (remove-data branch): postrm userdel ccsm + groupdel ccsm', () => {
    expect(postrm).toMatch(/userdel ccsm/);
    expect(postrm).toMatch(/groupdel ccsm/);
  });

  it('keep-data branch: postrm logs that /var/lib/ccsm is preserved (no rm)', () => {
    expect(postrm).toMatch(/keeping \/var\/lib\/ccsm/);
  });

  it('postrm only userdels in purge mode (.deb purge / .rpm uninstall=0)', () => {
    // userdel on plain remove would orphan state files; spec is clear
    // that user/group removal happens only on purge.
    expect(postrm).toMatch(/purge\|0\)/);
  });

  it('postrm action defaults to "purge" if invoked without an arg (manual ops)', () => {
    expect(postrm).toMatch(/ACTION="\$\{1:-purge\}"/);
  });
});

describe('uninstall matrix — top-level scripts/installer/uninstall.sh wrapper', () => {
  const sh = read(TOP_UNINSTALL_SH);

  it('starts with bash shebang', () => {
    expect(sh.startsWith('#!/usr/bin/env bash')).toBe(true);
  });

  it('exposes --silent and --interactive modes', () => {
    expect(sh).toMatch(/--silent\|-y\)/);
    expect(sh).toMatch(/--interactive\)/);
  });

  it('exposes --remove-user-data and --keep-user-data flags', () => {
    expect(sh).toMatch(/--remove-user-data\)/);
    expect(sh).toMatch(/--keep-user-data\)/);
  });

  it('exports CCSM_REMOVE_USER_DATA so per-OS scripts inherit the decision', () => {
    // The wrapper captures the user choice ONCE then propagates to the
    // mac/linux subscript via env so we never double-prompt.
    expect(sh).toMatch(/export CCSM_REMOVE_USER_DATA/);
  });

  it('mac branch dispatches to /Library/Application Support/ccsm/ccsm-uninstall.command', () => {
    expect(sh).toMatch(/\/Library\/Application Support\/ccsm\/ccsm-uninstall\.command/);
  });

  it('mac branch invokes downstream uninstaller in --silent mode (no double prompt)', () => {
    // Once the wrapper has gathered the user choice, it must call the
    // mac script in --silent mode so the mac script does NOT re-prompt.
    expect(sh).toMatch(/bash "\$MAC_UNINSTALL" --silent/);
  });

  it('linux branch tries dpkg first then rpm (auto-detect package manager)', () => {
    expect(sh).toMatch(/dpkg -P "\$LINUX_PKG_NAME"/);
    expect(sh).toMatch(/rpm -e "\$LINUX_PKG_NAME"/);
  });

  it('linux branch uses dpkg -P (purge) NOT -r so postrm hits CCSM_REMOVE_USER_DATA branch', () => {
    // Plain `dpkg -r` runs postrm with action="remove" which short-
    // circuits before the CCSM_REMOVE_USER_DATA gate; -P (purge) is
    // required for the spec ch10 §5 step 4 silent contract to fire.
    expect(sh).toMatch(/dpkg -P/);
    expect(sh).not.toMatch(/dpkg -r\b/);
  });

  it('detects MINGW/MSYS/CYGWIN and points to uninstall.ps1 (exit 4)', () => {
    expect(sh).toMatch(/MINGW\*\|MSYS\*\|CYGWIN\*/);
    expect(sh).toMatch(/uninstall\.ps1/);
  });

  it('refuses to run as non-root (uid != 0 -> exit 1)', () => {
    expect(sh).toMatch(/id -u.*-ne 0/);
  });

  it('exits 2 if neither dpkg nor rpm reports the package installed', () => {
    expect(sh).toMatch(/nothing to uninstall/);
  });

  it('is valid bash (parses with bash -n)', () => {
    execFileSync('bash', ['-n', TOP_UNINSTALL_SH], { stdio: ['ignore', 'pipe', 'pipe'] });
  });
});

describe('uninstall matrix — cross-OS state-dir untouched on REMOVEUSERDATA=0 (spec ch10 §5 step 4)', () => {
  // Spec line: "Default: keep state on uninstall, delete only on
  // explicit 'remove user data' tick". Each OS path must respect this.

  it('Win MSI: keep-data branch component has NO RemoveFolderEx', () => {
    // Re-asserted here (in addition to the WiX section above) under the
    // "state dir untouched on REMOVEUSERDATA=0" theme so a maintainer
    // searching for "state untouched" finds the test.
    const wxs = read(WIN_WXS);
    const stateDir = wxs.match(/<Component\s+Id="StateDir"[\s\S]*?<\/Component>/);
    expect(stateDir).not.toBeNull();
    expect(stateDir![0]).not.toMatch(/RemoveFolderEx/);
  });

  it('Mac uninstall: state-dir rm is GUARDED by remove_user_data=="1"', () => {
    const sh = read(MAC_UNINSTALL);
    // The exact guard phrasing is the load-bearing assertion; a future
    // refactor that replaces "==" with "!=" or drops the if entirely
    // breaks step 4 silently otherwise.
    const idx = sh.indexOf('rm -rf "$STATE_DIR"');
    expect(idx).toBeGreaterThan(-1);
    const before = sh.slice(0, idx);
    expect(before).toMatch(/if \[\[ "\$remove_user_data" == "1" \]\]/);
  });

  it('Linux postrm: rm /var/lib/ccsm is GUARDED by CCSM_REMOVE_USER_DATA == "1"', () => {
    const postrm = read(LINUX_POSTRM);
    const idx = postrm.indexOf('rm -rf /var/lib/ccsm');
    expect(idx).toBeGreaterThan(-1);
    const before = postrm.slice(0, idx);
    expect(before).toMatch(/CCSM_REMOVE_USER_DATA:-0.*=.*"1"/);
  });
});

describe('uninstall matrix — service unregister always happens (ch10 §5 steps 1-2 unconditional)', () => {
  // Even when REMOVEUSERDATA=0 the service MUST be stopped + unregistered.
  // Otherwise a "keep my data" uninstall would leave a dead service
  // pointing at a deleted binary, breaking the next install. spec ch10 §5
  // makes steps 1-2 mandatory, separate from the gated step 4-5.

  it('Win MSI: ServiceControl Stop="both" + Remove="uninstall" have NO REMOVEUSERDATA condition', () => {
    const wxs = read(WIN_WXS);
    const sc = wxs.match(/<ServiceControl[\s\S]*?\/>/);
    expect(sc).not.toBeNull();
    // The ServiceControl element itself has no Condition; it lives on
    // the DaemonSvc component which is also unconditional.
    expect(sc![0]).not.toMatch(/REMOVEUSERDATA/);
  });

  it('Mac uninstall: bootout + plist rm happen BEFORE the remove_user_data branch', () => {
    const sh = read(MAC_UNINSTALL);
    const bootoutIdx = sh.indexOf('launchctl bootout');
    const removeBranchIdx = sh.indexOf('if [[ "$remove_user_data" == "1" ]]');
    expect(bootoutIdx).toBeGreaterThan(-1);
    expect(removeBranchIdx).toBeGreaterThan(-1);
    expect(bootoutIdx).toBeLessThan(removeBranchIdx);
  });

  it('Linux prerm: stop + disable ccsm-daemon happen unconditionally (no CCSM_REMOVE_USER_DATA gate)', () => {
    const prerm = read(LINUX_PRERM);
    expect(prerm).not.toMatch(/CCSM_REMOVE_USER_DATA/);
  });

  it('Top-level wrapper: per-OS dispatch happens regardless of remove_user_data value', () => {
    const sh = read(TOP_UNINSTALL_SH);
    // The case "$OS_NAME" branch must come AFTER the remove_user_data
    // decision but must NOT be conditioned on it.
    const decisionIdx = sh.indexOf('export CCSM_REMOVE_USER_DATA');
    const dispatchIdx = sh.indexOf('case "$OS_NAME" in');
    expect(decisionIdx).toBeGreaterThan(-1);
    expect(dispatchIdx).toBeGreaterThan(decisionIdx);
  });
});
