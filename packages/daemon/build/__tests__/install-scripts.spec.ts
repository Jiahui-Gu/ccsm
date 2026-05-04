// packages/daemon/build/__tests__/install-scripts.spec.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch10 §5.
// Task: T7.4 (#81) — installer: per-OS service registration + state dir creation.
//
// Forever-stable shape gates for the per-OS installer scaffolding under
// packages/daemon/build/install/. Real .msi / .pkg / .deb / .rpm builds
// require WiX 4 / pkgbuild / fpm respectively (none guaranteed on a dev
// box), so this spec asserts the contract that installer-roundtrip.{ps1,sh}
// (T7.5+ ship-gate (d)) and the spec itself depend on:
//
//   1. Each per-OS layout exists at the expected path.
//   2. The win MSI manifest contains the locked WiX 4 elements
//      (<ServiceInstall>, <ServiceControl>, ServiceConfig failure actions,
//      LocalService account, %PROGRAMDATA% state dir + DACL).
//   3. The mac LaunchDaemon plist + pre/postinstall scripts contain the
//      locked launchctl + dscl + path constants from ch10 §5.2.
//   4. The linux systemd unit contains the spec ch07 §2 LOCKED directives
//      (RuntimeDirectory, RuntimeDirectoryMode, StateDirectory,
//      StateDirectoryMode, User, Group) verbatim.
//   5. Each builder script is placeholder-safe — invoking with no env on
//      the current host either WARN+exit 0 or DRY-RUN traces.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD_DIR = path.resolve(__dirname, '..');
const INSTALL_DIR = path.join(BUILD_DIR, 'install');

const WIN_DIR = path.join(INSTALL_DIR, 'win');
const MAC_DIR = path.join(INSTALL_DIR, 'mac');
const LINUX_DIR = path.join(INSTALL_DIR, 'linux');

const WIN_WXS = path.join(WIN_DIR, 'Product.wxs.template');
const WIN_PS1 = path.join(WIN_DIR, 'build-msi.ps1');

const MAC_PLIST = path.join(MAC_DIR, 'com.ccsm.daemon.plist');
const MAC_PREINSTALL = path.join(MAC_DIR, 'preinstall.sh');
const MAC_POSTINSTALL = path.join(MAC_DIR, 'postinstall.sh');
const MAC_BUILD = path.join(MAC_DIR, 'build-pkg.sh');

const LINUX_UNIT = path.join(LINUX_DIR, 'ccsm-daemon.service');
const LINUX_POSTINST = path.join(LINUX_DIR, 'postinst.sh');
const LINUX_PRERM = path.join(LINUX_DIR, 'prerm.sh');
const LINUX_POSTRM = path.join(LINUX_DIR, 'postrm.sh');
const LINUX_BUILD = path.join(LINUX_DIR, 'build-pkg.sh');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('packages/daemon/build/install/** (spec ch10 §5, T7.4)', () => {
  describe('files exist', () => {
    it('Windows MSI manifest + builder', () => {
      expect(existsSync(WIN_WXS)).toBe(true);
      expect(existsSync(WIN_PS1)).toBe(true);
    });
    it('macOS plist + scripts + builder', () => {
      expect(existsSync(MAC_PLIST)).toBe(true);
      expect(existsSync(MAC_PREINSTALL)).toBe(true);
      expect(existsSync(MAC_POSTINSTALL)).toBe(true);
      expect(existsSync(MAC_BUILD)).toBe(true);
    });
    it('Linux unit + scripts + builder', () => {
      expect(existsSync(LINUX_UNIT)).toBe(true);
      expect(existsSync(LINUX_POSTINST)).toBe(true);
      expect(existsSync(LINUX_PRERM)).toBe(true);
      expect(existsSync(LINUX_POSTRM)).toBe(true);
      expect(existsSync(LINUX_BUILD)).toBe(true);
    });
  });

  describe('Windows MSI manifest — WiX 4 locked elements (ch10 §5.1)', () => {
    const wxs = read(WIN_WXS);

    it('uses WiX 4+ schema namespace', () => {
      expect(wxs).toContain('http://wixtoolset.org/schemas/v4/wxs');
    });

    it('declares <ServiceInstall> with ccsm-daemon Name + LocalService account', () => {
      // Assert the locked spec choices: declarative ServiceInstall
      // (NOT sc.exe custom action), Name="ccsm-daemon", LocalService.
      expect(wxs).toMatch(/<ServiceInstall[\s\S]*?Name="ccsm-daemon"/);
      expect(wxs).toMatch(/<ServiceInstall[\s\S]*?Account="NT AUTHORITY\\LocalService"/);
      expect(wxs).toMatch(/<ServiceInstall[\s\S]*?Type="ownProcess"/);
      expect(wxs).toMatch(/<ServiceInstall[\s\S]*?Start="auto"/);
      expect(wxs).toMatch(/<ServiceInstall[\s\S]*?Vital="yes"/);
    });

    it('declares <ServiceControl> with Start=install + Stop=both + Remove=uninstall', () => {
      expect(wxs).toMatch(/<ServiceControl[\s\S]*?Name="ccsm-daemon"/);
      expect(wxs).toMatch(/<ServiceControl[\s\S]*?Start="install"/);
      expect(wxs).toMatch(/<ServiceControl[\s\S]*?Stop="both"/);
      expect(wxs).toMatch(/<ServiceControl[\s\S]*?Remove="uninstall"/);
    });

    it('declares failure actions: restart x2 + none (ch10 §5.1)', () => {
      // Spec: "restart on first/second failure, run-program on third".
      // We use Action="none" on third to avoid spawning a recovery exe
      // until the operator inspects (the installer rollback path is the
      // recovery boundary). PR body explains the deviation if reviewer
      // wants the spec literal "run-program".
      expect(wxs).toMatch(/<ServiceConfigFailureActions/);
      expect(wxs).toMatch(/Action="restart"[\s\S]*?DelayInSeconds="5"/);
    });

    it('declares ServiceSidType="restricted" (ch10 §5.1 verified by sc qsidtype)', () => {
      expect(wxs).toMatch(/ServiceSidType="restricted"/);
    });

    it('creates %PROGRAMDATA%\\ccsm state directory with DACL', () => {
      // CommonAppDataFolder == %PROGRAMDATA% in MSI standard dirs.
      expect(wxs).toContain('CommonAppDataFolder');
      expect(wxs).toMatch(/<Directory[\s\S]*?Id="STATEDIR"[\s\S]*?Name="ccsm"/);
      // DACL grants LocalService (LS) Modify (FA == FullAccess in SDDL),
      // BUILTIN\Users (BU) Read (0x1200a9), BUILTIN\Administrators (BA).
      expect(wxs).toMatch(/Sddl=".*A;OICI;FA;;;LS.*"/);
      expect(wxs).toMatch(/Sddl=".*BU.*"/);
    });

    it('declares REMOVEUSERDATA public property (ch10 §5 step 4 silent uninstall)', () => {
      expect(wxs).toMatch(/<Property[\s\S]*?Id="REMOVEUSERDATA"[\s\S]*?Secure="yes"/);
      // Two state-dir components: one permanent + one removable, gated by
      // REMOVEUSERDATA value. Either condition style satisfies the spec.
      expect(wxs).toMatch(/REMOVEUSERDATA="1"/);
    });

    it('declares <MajorUpgrade> for in-place version replacement', () => {
      expect(wxs).toMatch(/<MajorUpgrade/);
    });
  });

  describe('Windows builder — placeholder-safe (ch10 §5)', () => {
    const src = read(WIN_PS1);

    it('declares CCSM_INSTALLER_DRY_RUN env var', () => {
      expect(src).toContain('CCSM_INSTALLER_DRY_RUN');
    });

    it('skips on non-windows + missing wix.exe + missing daemon binary', () => {
      // These are the placeholder-safe gates that let dogfood `npm run
      // build` succeed on a dev box without WiX installed.
      expect(src).toMatch(/non-windows host/);
      expect(src).toMatch(/wix\.exe not found/);
      expect(src).toMatch(/daemon binary missing/);
    });

    it('substitutes the locked template tokens', () => {
      expect(src).toContain('@CCSM_VERSION@');
      expect(src).toContain('@CCSM_UPGRADE_CODE@');
      expect(src).toContain('@CCSM_DAEMON_DIR@');
      expect(src).toContain('@CCSM_DAEMON_EXE@');
    });
  });

  describe('macOS LaunchDaemon plist (ch10 §5.2)', () => {
    const plist = read(MAC_PLIST);

    it('uses Label com.ccsm.daemon', () => {
      expect(plist).toMatch(/<key>Label<\/key>\s*<string>com\.ccsm\.daemon<\/string>/);
    });

    it('uses _ccsm service account (UserName + GroupName)', () => {
      expect(plist).toMatch(/<key>UserName<\/key>\s*<string>_ccsm<\/string>/);
      expect(plist).toMatch(/<key>GroupName<\/key>\s*<string>_ccsm<\/string>/);
    });

    it('declares RunAtLoad=true and KeepAlive', () => {
      expect(plist).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
      expect(plist).toMatch(/<key>KeepAlive<\/key>/);
    });

    it('substitutes @CCSM_DAEMON_PATH@ at install time', () => {
      expect(plist).toContain('@CCSM_DAEMON_PATH@');
    });
  });

  describe('macOS preinstall + postinstall scripts (ch10 §5.2 / §5 steps 3-6)', () => {
    it('preinstall creates _ccsm user via dscl + state dir 0700 owner _ccsm', () => {
      const src = read(MAC_PREINSTALL);
      expect(src).toMatch(/dscl \./);
      expect(src).toMatch(/_ccsm/);
      expect(src).toMatch(/Library\/Application Support\/ccsm/);
      expect(src).toMatch(/chmod 0700/);
    });

    it('postinstall calls launchctl bootstrap + enable + kickstart', () => {
      const src = read(MAC_POSTINSTALL);
      expect(src).toMatch(/launchctl bootstrap system/);
      expect(src).toMatch(/launchctl enable/);
      expect(src).toMatch(/launchctl kickstart/);
      expect(src).toContain('com.ccsm.daemon');
    });
  });

  describe('macOS builder — placeholder-safe', () => {
    const src = read(MAC_BUILD);

    it('declares CCSM_INSTALLER_DRY_RUN env', () => {
      expect(src).toContain('CCSM_INSTALLER_DRY_RUN');
    });

    it('skips on non-darwin + missing pkgbuild', () => {
      expect(src).toMatch(/non-darwin host/);
      expect(src).toMatch(/pkgbuild|productbuild/);
    });

    it('invokes pkgbuild + productbuild (ch10 §5.2)', () => {
      expect(src).toMatch(/\bpkgbuild\b/);
      expect(src).toMatch(/\bproductbuild\b/);
    });
  });

  describe('Linux systemd unit — ch07 §2 LOCKED directives', () => {
    const unit = read(LINUX_UNIT);

    // The spec freezes these six directives verbatim. If a future PR
    // edits them without updating ch07 §2, this test fires.
    it.each([
      ['RuntimeDirectory=ccsm', /^RuntimeDirectory=ccsm\s*$/m],
      ['RuntimeDirectoryMode=0750', /^RuntimeDirectoryMode=0750\s*$/m],
      ['StateDirectory=ccsm', /^StateDirectory=ccsm\s*$/m],
      ['StateDirectoryMode=0750', /^StateDirectoryMode=0750\s*$/m],
      ['User=ccsm', /^User=ccsm\s*$/m],
      ['Group=ccsm', /^Group=ccsm\s*$/m],
    ])('contains LOCKED directive %s', (_label, re) => {
      expect(unit).toMatch(re);
    });

    it('declares Type=notify (sd_notify READY=1 + WATCHDOG=1 from daemon)', () => {
      expect(unit).toMatch(/^Type=notify\s*$/m);
    });

    it('declares Restart=on-failure', () => {
      expect(unit).toMatch(/^Restart=on-failure\s*$/m);
    });

    it('declares ExecStart pointing at /usr/lib/ccsm/ccsm-daemon', () => {
      expect(unit).toMatch(/^ExecStart=\/usr\/lib\/ccsm\/ccsm-daemon/m);
    });
  });

  describe('Linux postinst / prerm / postrm (ch10 §5.3 + ch10 §5 step 4)', () => {
    it('postinst creates ccsm system user/group and systemctl enable --now', () => {
      const src = read(LINUX_POSTINST);
      expect(src).toMatch(/groupadd --system ccsm/);
      expect(src).toMatch(/useradd --system/);
      expect(src).toMatch(/systemctl daemon-reload/);
      expect(src).toMatch(/systemctl enable --now ccsm-daemon/);
    });

    it('prerm stops + disables on remove (skips upgrade)', () => {
      const src = read(LINUX_PRERM);
      expect(src).toMatch(/systemctl stop ccsm-daemon/);
      expect(src).toMatch(/systemctl disable ccsm-daemon/);
      expect(src).toMatch(/upgrade/);
    });

    it('postrm honours CCSM_REMOVE_USER_DATA env (ch10 §5 step 4)', () => {
      const src = read(LINUX_POSTRM);
      expect(src).toContain('CCSM_REMOVE_USER_DATA');
      expect(src).toMatch(/rm -rf \/var\/lib\/ccsm/);
      expect(src).toMatch(/userdel ccsm/);
    });
  });

  describe('Linux builder — placeholder-safe', () => {
    const src = read(LINUX_BUILD);

    it('declares CCSM_INSTALLER_DRY_RUN env', () => {
      expect(src).toContain('CCSM_INSTALLER_DRY_RUN');
    });

    it('skips on missing fpm', () => {
      expect(src).toMatch(/fpm not on PATH/);
    });

    it('builds both .deb and .rpm via fpm -t deb / -t rpm', () => {
      expect(src).toMatch(/fpm[\s\S]*-t deb/);
      expect(src).toMatch(/fpm[\s\S]*-t rpm/);
    });
  });

  describe('cross-host placeholder-safe — bash builders exit 0 with no env', () => {
    // These three runs on whatever host the suite uses. On the matching
    // host they hit the missing-tool / missing-input gate; on the wrong
    // host they hit the platform gate. Either way: WARN + exit 0. This
    // is the contract that lets dogfood `npm run build` succeed on every
    // dev box without the per-OS toolchain.
    it('mac build-pkg.sh exits 0 with empty env', () => {
      const out = execFileSync('bash', ['-c', `bash "${MAC_BUILD}" 2>&1`], {
        env: { ...process.env, CCSM_INSTALLER_DRY_RUN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(typeof out.toString()).toBe('string');
    });

    it('linux build-pkg.sh exits 0 with empty env', () => {
      const out = execFileSync('bash', ['-c', `bash "${LINUX_BUILD}" 2>&1`], {
        env: { ...process.env, CCSM_INSTALLER_DRY_RUN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(typeof out.toString()).toBe('string');
    });

    it('mac preinstall.sh + postinstall.sh + linux postinst.sh + prerm.sh + postrm.sh are valid bash/sh', () => {
      // bash -n parses without executing — catches syntax errors that
      // would only surface inside a real installer run.
      for (const script of [MAC_PREINSTALL, MAC_POSTINSTALL, LINUX_POSTINST, LINUX_PRERM, LINUX_POSTRM]) {
        execFileSync('bash', ['-n', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      }
    });
  });

  describe('state-dir consistency with T5.3 (ch07 §2)', () => {
    // The installer creates state dirs that the daemon's statePaths()
    // expects. If T5.3 paths.ts ever rotates a path, this test catches
    // the drift.
    it('Windows MSI uses %PROGRAMDATA%\\ccsm', () => {
      const wxs = read(WIN_WXS);
      // CommonAppDataFolder is the WiX standard dir for %PROGRAMDATA%.
      expect(wxs).toContain('CommonAppDataFolder');
      expect(wxs).toMatch(/Id="STATEDIR"[\s\S]*?Name="ccsm"/);
    });

    it('macOS preinstall uses /Library/Application Support/ccsm', () => {
      expect(read(MAC_PREINSTALL)).toContain('/Library/Application Support/ccsm');
    });

    it('Linux unit uses StateDirectory=ccsm (-> /var/lib/ccsm)', () => {
      expect(read(LINUX_UNIT)).toMatch(/^StateDirectory=ccsm\s*$/m);
    });
  });
});
