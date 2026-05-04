// packages/daemon/build/__tests__/post-install-healthz.spec.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md
//       chapter 10 §5 step 7 (post-install /healthz wait + 10s failure rollback).
// Task: T7.5 (#78) — installer: post-install /healthz wait + 10s failure rollback.
//
// Forever-stable shape gates for the post-install healthz wait scripts
// (post-install-healthz.{sh,ps1}) and the WiX 4 CustomAction integration.
// Real installer e2e (running the .msi / .pkg / .deb / .rpm against a live
// daemon) is owned by tools/sea-smoke/ (ch10 §7) and the
// e2e-win-installer-vm CI job. This spec asserts the contract those e2e
// jobs depend on:
//
//   1. Each script + WiX template exists at the expected path.
//   2. Each script implements the locked spec choices verbatim
//      (10s timeout, ch10 §5 step 7 log-capture commands, scripted
//      uninstall on rollback, state dir untouched).
//   3. Each script's failure exit code matches the spec mapping
//      (sh: 10/11; ps1: 1603 ERROR_INSTALL_FAILURE).
//   4. Per-OS service log capture command matches the spec literal
//      (journalctl -u / log show / Get-WinEvent).
//   5. WiX 4 CustomAction is sequenced after StartServices and uses
//      Return="check" so 1603 propagates to the rollback transaction.
//   6. Sh script exit-code branches are exercisable via DRY-RUN +
//      forced outcome envs (success / timeout / non200).
//   7. Post-install scripts (mac postinstall.sh, linux postinst.sh)
//      invoke the healthz script and treat its non-zero as rollback.
//   8. Builders stage the healthz script into the package payload at
//      the path the post-install scripts resolve.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const BUILD_DIR  = path.resolve(__dirname, '..');
const INSTALL    = path.join(BUILD_DIR, 'install');

const HEALTHZ_SH  = path.join(INSTALL, 'post-install-healthz.sh');
const HEALTHZ_PS1 = path.join(INSTALL, 'post-install-healthz.ps1');
const HEALTHZ_CA  = path.join(INSTALL, 'win', 'HealthzCustomAction.wxs.template');

const WIN_WXS     = path.join(INSTALL, 'win', 'Product.wxs.template');
const WIN_BUILD   = path.join(INSTALL, 'win', 'build-msi.ps1');

const MAC_POST    = path.join(INSTALL, 'mac', 'postinstall.sh');
const MAC_BUILD   = path.join(INSTALL, 'mac', 'build-pkg.sh');

const LINUX_POST  = path.join(INSTALL, 'linux', 'postinst.sh');
const LINUX_BUILD = path.join(INSTALL, 'linux', 'build-pkg.sh');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('packages/daemon/build/install/post-install-healthz.* (spec ch10 §5 step 7, T7.5)', () => {
  describe('files exist', () => {
    it('post-install-healthz.sh', () => {
      expect(existsSync(HEALTHZ_SH)).toBe(true);
    });
    it('post-install-healthz.ps1', () => {
      expect(existsSync(HEALTHZ_PS1)).toBe(true);
    });
    it('win/HealthzCustomAction.wxs.template', () => {
      expect(existsSync(HEALTHZ_CA)).toBe(true);
    });
  });

  describe('post-install-healthz.sh — spec ch10 §5 step 7 (mac + linux)', () => {
    const src = read(HEALTHZ_SH);

    it('default timeout is 10 seconds (locked by spec)', () => {
      expect(src).toMatch(/CCSM_HEALTHZ_TIMEOUT_SECONDS:?-10\}/);
    });

    it('targets Supervisor UDS at /run/ccsm/supervisor.sock on linux (ch03 §7)', () => {
      expect(src).toContain('/run/ccsm/supervisor.sock');
    });

    it('targets Supervisor UDS at /var/run/com.ccsm.daemon/supervisor.sock on mac (ch03 §7)', () => {
      expect(src).toContain('/var/run/com.ccsm.daemon/supervisor.sock');
    });

    it('uses curl --unix-socket to probe over UDS (not loopback TCP)', () => {
      expect(src).toMatch(/curl[\s\S]*?--unix-socket/);
      // Must NOT use http://127.0.0.1 — Supervisor is UDS-only forever
      // (ch03 §7 explicit "no loopback TCP supervisor").
      expect(src).not.toMatch(/http:\/\/127\.0\.0\.1/);
    });

    it('linux log capture uses journalctl -u ccsm-daemon.service -n 200 --no-pager (ch10 §5 step 7)', () => {
      expect(src).toMatch(/journalctl -u ccsm-daemon\.service -n \$\{LOG_TAIL_LINES\} --no-pager/);
    });

    it('mac log capture uses log show --predicate process=="ccsm-daemon" --last 5m (ch10 §5 step 7)', () => {
      // The literal string is wrapped in a double-quoted shell echo so
      // the inner double-quotes are backslash-escaped. Match either form.
      expect(src).toMatch(/log show --predicate 'process == \\?"ccsm-daemon\\?"' --last 5m/);
    });

    it('linux rollback runs systemctl disable --now ccsm-daemon (state dir untouched)', () => {
      expect(src).toMatch(/systemctl disable --now ccsm-daemon/);
      // Must NOT rm the state dir — spec ch10 §5 step 7 explicit "state dir UNTOUCHED".
      expect(src).not.toMatch(/rm -rf \/var\/lib\/ccsm/);
    });

    it('mac rollback runs launchctl bootout system/com.ccsm.daemon (state dir untouched)', () => {
      expect(src).toMatch(/launchctl bootout system\/com\.ccsm\.daemon/);
      // Must NOT rm /Library/Application Support/ccsm.
      expect(src).not.toMatch(/rm -rf \/Library\/Application Support\/ccsm/);
    });

    it('uses --max-time per probe so a hung daemon does not blow the 10s budget', () => {
      expect(src).toMatch(/--max-time/);
    });

    it('declares forever-stable exit codes 0/10/11/12/13/14', () => {
      // Forever-stable contract: callers (postinst.sh / postinstall.sh)
      // distinguish timeout (10) from non-200 (11) for telemetry.
      expect(src).toMatch(/^#\s*0\s+/m);
      expect(src).toMatch(/^#\s*10\s+/m);
      expect(src).toMatch(/^#\s*11\s+/m);
      expect(src).toMatch(/^#\s*12\s+/m);
      expect(src).toMatch(/^#\s*13\s+/m);
      expect(src).toMatch(/^#\s*14\s+/m);
    });

    it('honours CCSM_HEALTHZ_DRY_RUN + CCSM_HEALTHZ_FORCE_OUTCOME for unit tests', () => {
      expect(src).toContain('CCSM_HEALTHZ_DRY_RUN');
      expect(src).toContain('CCSM_HEALTHZ_FORCE_OUTCOME');
    });

    it('is valid bash (parses with bash -n)', () => {
      execFileSync('bash', ['-n', HEALTHZ_SH], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
  });

  describe('post-install-healthz.sh — DRY-RUN exit-code branches', () => {
    function runForced(outcome: string): { status: number; stdout: string; stderr: string } {
      try {
        const stdout = execFileSync('bash', [HEALTHZ_SH], {
          env: {
            ...process.env,
            CCSM_HEALTHZ_DRY_RUN: '1',
            CCSM_HEALTHZ_FORCE_OUTCOME: outcome,
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }).toString();
        return { status: 0, stdout, stderr: '' };
      } catch (e: unknown) {
        // execFileSync throws on non-zero exit; the error carries status + stderr.
        const err = e as { status: number; stdout: Buffer | string; stderr: Buffer | string };
        return {
          status: err.status,
          stdout: err.stdout?.toString() ?? '',
          stderr: err.stderr?.toString() ?? '',
        };
      }
    }

    it('success path -> exit 0 + logs OK', () => {
      const r = runForced('success');
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/OK — \/healthz returned 200/);
    });

    it('timeout path -> exit 10 + log-capture command in stderr + state-dir preservation note', () => {
      const r = runForced('timeout');
      expect(r.status).toBe(10);
      // Spec literal: log capture command appears in stderr.
      expect(r.stderr).toMatch(/journalctl|log show/);
      // State dir preservation explicit per ch10 §5 step 7.
      expect(r.stderr).toMatch(/state dir preserved/);
      // Rollback command surfaced.
      expect(r.stderr).toMatch(/systemctl disable|launchctl bootout/);
    });

    it('non200 path -> exit 11 + log-capture + rollback + state-dir preservation', () => {
      const r = runForced('non200');
      expect(r.status).toBe(11);
      expect(r.stderr).toMatch(/journalctl|log show/);
      expect(r.stderr).toMatch(/state dir preserved/);
      expect(r.stderr).toMatch(/systemctl disable|launchctl bootout/);
    });
  });

  describe('post-install-healthz.ps1 — spec ch10 §5 step 7 (windows)', () => {
    const src = read(HEALTHZ_PS1);

    it('default timeout is 10 seconds (locked by spec)', () => {
      expect(src).toMatch(/\$TimeoutSeconds\s*=.*\b10\b/);
    });

    it('targets Supervisor named pipe \\\\.\\pipe\\ccsm-supervisor (ch03 §7)', () => {
      expect(src).toMatch(/PipeName\s*=\s*'ccsm-supervisor'/);
    });

    it('uses NamedPipeClientStream (not Invoke-WebRequest TCP) per ch03 §7 UDS-only constraint', () => {
      expect(src).toContain('System.IO.Pipes.NamedPipeClientStream');
      // Must NOT use Invoke-WebRequest with http://127.0.0.1 — Supervisor is UDS-only.
      expect(src).not.toMatch(/Invoke-WebRequest[\s\S]*?127\.0\.0\.1/);
    });

    it('writes a literal HTTP/1.1 GET /healthz request', () => {
      expect(src).toMatch(/GET \/healthz HTTP\/1\.1/);
    });

    it('exits ERROR_INSTALL_FAILURE 1603 on failure (MSI rollback trigger)', () => {
      expect(src).toMatch(/\$ErrorInstallFailure\s*=\s*1603/);
      // Both timeout and non-200 paths must propagate 1603 so MSI rollback fires.
      expect(src).toMatch(/exit \$ErrorInstallFailure/);
    });

    it('captures Get-WinEvent -LogName Application -MaxEvents 200 filtered to ccsm provider (ch10 §5 step 7)', () => {
      // Spec literal command is asserted verbatim modulo the LogTailLines variable.
      expect(src).toMatch(/Get-WinEvent -LogName Application -MaxEvents \$LogTailLines/);
      expect(src).toMatch(/ProviderName -like '\*ccsm\*'/);
    });

    it('preserves state dir under %PROGRAMDATA%\\ccsm on rollback (StateDir is Permanent)', () => {
      expect(src).toMatch(/state directory under %PROGRAMDATA%\\ccsm preserved/);
      // Must NOT call Remove-Item against %PROGRAMDATA%\ccsm.
      expect(src).not.toMatch(/Remove-Item[\s\S]*?ProgramData\\ccsm/);
    });

    it('honours CCSM_HEALTHZ_DRY_RUN + CCSM_HEALTHZ_FORCE_OUTCOME for unit tests', () => {
      expect(src).toContain('CCSM_HEALTHZ_DRY_RUN');
      expect(src).toContain('CCSM_HEALTHZ_FORCE_OUTCOME');
    });
  });

  describe('WiX 4 CustomAction (HealthzCustomAction.wxs.template) — ch10 §5 step 7', () => {
    const ca = read(HEALTHZ_CA);

    it('uses WiX 4+ schema namespace (matches T7.4 Product.wxs.template)', () => {
      expect(ca).toContain('http://wixtoolset.org/schemas/v4/wxs');
    });

    it('declares <Binary> embedding post-install-healthz.ps1 via @CCSM_HEALTHZ_PS1@ token', () => {
      expect(ca).toMatch(/<Binary[\s\S]*?Id="HealthzPs1Bin"[\s\S]*?SourceFile="@CCSM_HEALTHZ_PS1@"/);
    });

    it('declares <CustomAction Id="CcsmHealthzCheck"> with Return="check" (propagates 1603)', () => {
      expect(ca).toMatch(/<CustomAction[\s\S]*?Id="CcsmHealthzCheck"/);
      expect(ca).toMatch(/<CustomAction[\s\S]*?Return="check"/);
    });

    it('runs powershell.exe with -ExecutionPolicy Bypass -File [#HealthzPs1Bin]', () => {
      expect(ca).toMatch(/powershell\.exe[\s\S]*?-ExecutionPolicy Bypass[\s\S]*?-File "\[#HealthzPs1Bin\]"/);
    });

    it('is deferred + impersonate=no so it runs as SYSTEM in install transaction', () => {
      expect(ca).toMatch(/Execute="deferred"/);
      expect(ca).toMatch(/Impersonate="no"/);
    });

    it('sequences After="StartServices" with NOT REMOVE condition (install-only)', () => {
      expect(ca).toMatch(/<Custom[\s\S]*?Action="CcsmHealthzCheck"[\s\S]*?After="StartServices"[\s\S]*?Condition="NOT REMOVE"/);
    });
  });

  describe('Product.wxs.template — references CcsmHealthzCheck CustomAction', () => {
    const wxs = read(WIN_WXS);

    it('declares <CustomActionRef Id="CcsmHealthzCheck"/> so the Fragment is pulled in', () => {
      expect(wxs).toMatch(/<CustomActionRef\s+Id="CcsmHealthzCheck"\s*\/>/);
    });
  });

  describe('build-msi.ps1 — stages healthz script + compiles CA fragment', () => {
    const src = read(WIN_BUILD);

    it('copies post-install-healthz.ps1 next to the daemon binary', () => {
      expect(src).toContain('post-install-healthz.ps1');
      expect(src).toMatch(/Copy-Item[\s\S]*?HealthzPs1Src[\s\S]*?HealthzPs1Dst/);
    });

    it('expands HealthzCustomAction.wxs.template substituting @CCSM_HEALTHZ_PS1@', () => {
      expect(src).toContain('HealthzCustomAction.wxs.template');
      expect(src).toMatch(/@CCSM_HEALTHZ_PS1@/);
    });

    it('passes the expanded HealthzCustomAction.wxs to wix build', () => {
      // Both wxs files must appear in the wix build args.
      expect(src).toMatch(/\$wixArgs\s*=\s*@\([\s\S]*?\$Wxs[\s\S]*?\$HealthzWxs/);
    });
  });

  describe('mac postinstall.sh wires healthz (ch10 §5 step 7 — mac)', () => {
    const src = read(MAC_POST);

    it('invokes post-install-healthz.sh sibling-resolved', () => {
      expect(src).toContain('post-install-healthz.sh');
      expect(src).toMatch(/dirname -- "\$0"/);
    });

    it('treats non-zero healthz exit as installer failure (exit 1)', () => {
      // mac .pkg uses non-zero postinstall as the installer-fail signal,
      // which is what we want — the underlying rollback (launchctl bootout)
      // is performed by the healthz script itself.
      expect(src).toMatch(/exit 1/);
    });

    it('is valid bash (parses with bash -n)', () => {
      execFileSync('bash', ['-n', MAC_POST], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
  });

  describe('linux postinst.sh wires healthz (ch10 §5 step 7 — linux)', () => {
    const src = read(LINUX_POST);

    it('invokes post-install-healthz.sh from /usr/lib/ccsm/ (payload-resolved, not $0-relative)', () => {
      // dpkg/rpm install maintainer scripts to /var/lib/dpkg/info/ — sibling
      // $0-resolution does NOT find package payload files. The script must
      // hard-code the payload path /usr/lib/ccsm/post-install-healthz.sh.
      expect(src).toMatch(/HEALTHZ_SH="\/usr\/lib\/ccsm\/post-install-healthz\.sh"/);
    });

    it('does NOT propagate healthz failure as postinst non-zero (avoids dpkg/rpm half-removed state)', () => {
      // The healthz script does the rollback (systemctl disable --now);
      // postinst exiting non-zero would block the package manager
      // transaction. The trailing exit must be 0.
      expect(src).toMatch(/^exit 0\s*$/m);
    });

    it('is valid POSIX sh (parses with bash -n)', () => {
      execFileSync('bash', ['-n', LINUX_POST], { stdio: ['ignore', 'pipe', 'pipe'] });
    });
  });

  describe('builders stage post-install-healthz.sh into payload', () => {
    it('mac build-pkg.sh copies post-install-healthz.sh into Scripts/', () => {
      const src = read(MAC_BUILD);
      expect(src).toMatch(/cp\s+"\$BUILD_DIR\/install\/post-install-healthz\.sh"\s+"\$SCRIPTS\/post-install-healthz\.sh"/);
      expect(src).toMatch(/chmod 0755[\s\S]*?post-install-healthz\.sh/);
    });

    it('linux build-pkg.sh stages post-install-healthz.sh into /usr/lib/ccsm/', () => {
      const src = read(LINUX_BUILD);
      expect(src).toMatch(/cp\s+"\$BUILD_DIR\/install\/post-install-healthz\.sh"\s+"\$STAGE\/usr\/lib\/ccsm\/post-install-healthz\.sh"/);
    });
  });

  describe('cross-cutting: state-dir UNTOUCHED across rollback (spec ch10 §5 step 7 explicit)', () => {
    it('healthz.sh does not delete linux state dir /var/lib/ccsm', () => {
      expect(read(HEALTHZ_SH)).not.toMatch(/rm -rf \/var\/lib\/ccsm/);
    });

    it('healthz.sh does not delete mac state dir /Library/Application Support/ccsm', () => {
      expect(read(HEALTHZ_SH)).not.toMatch(/rm -rf \/Library\/Application Support\/ccsm/);
    });

    it('healthz.ps1 does not delete %PROGRAMDATA%\\ccsm', () => {
      expect(read(HEALTHZ_PS1)).not.toMatch(/Remove-Item[\s\S]*?ProgramData[\\/]+ccsm/);
    });

    it('healthz.ps1 documents that StateDir component is Permanent (T7.4 contract)', () => {
      expect(read(HEALTHZ_PS1)).toMatch(/StateDir component is Permanent/);
    });
  });
});
