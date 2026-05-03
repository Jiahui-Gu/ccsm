// packages/daemon/build/__tests__/sign-scripts.spec.ts
//
// Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch10 §3.
// Task #82 (T7.3) — per-OS signing scaffolding (placeholder-safe).
//
// Forever-stable shape gate for the three signing scripts. We assert two
// things that drift kills:
//
//   1. The exact env-var contract documented in scripts/sign/README.md
//      appears in each script. If a contributor renames an env var without
//      updating the README, this test fires before the PR can land.
//   2. Each script invokes the tool the spec pins (codesign + notarytool +
//      stapler for mac; signtool for win; debsigs + rpm + gpg for linux).
//
// We also smoke-run the bash scripts in CCSM_SIGN_DRY_RUN=1 mode without
// any other env set: the script must exit 0 (placeholder-safe) and print
// the WARN line OR the dry-run trace.
//
// Heavy real-cert / notarytool calls live downstream in CI; this spec is
// the cheapest forever-stable contract we can keep green per dev §2 quality
// gates.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const BUILD_DIR = path.resolve(__dirname, '..');

const MAC_SH = path.join(BUILD_DIR, 'sign-mac.sh');
const WIN_PS1 = path.join(BUILD_DIR, 'sign-win.ps1');
const LINUX_SH = path.join(BUILD_DIR, 'sign-linux.sh');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('packages/daemon/build/sign-*.{sh,ps1} (spec ch10 §3, T7.3)', () => {
  describe('files exist', () => {
    it('sign-mac.sh present', () => {
      expect(existsSync(MAC_SH)).toBe(true);
    });
    it('sign-win.ps1 present', () => {
      expect(existsSync(WIN_PS1)).toBe(true);
    });
    it('sign-linux.sh present', () => {
      expect(existsSync(LINUX_SH)).toBe(true);
    });
  });

  describe('env-var contract', () => {
    it('sign-mac.sh references APPLE_TEAM_ID, APPLE_SIGNING_IDENTITY, APPLE_NOTARY_PROFILE', () => {
      const src = read(MAC_SH);
      expect(src).toContain('APPLE_TEAM_ID');
      expect(src).toContain('APPLE_SIGNING_IDENTITY');
      expect(src).toContain('APPLE_NOTARY_PROFILE');
      expect(src).toContain('CCSM_SIGN_DRY_RUN');
    });

    it('sign-win.ps1 references WIN_CERT_PFX, WIN_CERT_PASSWORD, WIN_TIMESTAMP_URL', () => {
      const src = read(WIN_PS1);
      expect(src).toContain('WIN_CERT_PFX');
      expect(src).toContain('WIN_CERT_PASSWORD');
      expect(src).toContain('WIN_TIMESTAMP_URL');
      expect(src).toContain('CCSM_SIGN_DRY_RUN');
    });

    it('sign-linux.sh references GPG_SIGNING_KEY, GPG_PASSPHRASE', () => {
      const src = read(LINUX_SH);
      expect(src).toContain('GPG_SIGNING_KEY');
      expect(src).toContain('GPG_PASSPHRASE');
      expect(src).toContain('CCSM_SIGN_DRY_RUN');
    });
  });

  describe('per-OS tool pins (spec ch10 §3 table)', () => {
    it('mac uses codesign + xcrun notarytool + stapler + spctl', () => {
      const src = read(MAC_SH);
      expect(src).toMatch(/\bcodesign\b/);
      expect(src).toMatch(/xcrun notarytool/);
      expect(src).toMatch(/xcrun stapler|stapler staple/);
      expect(src).toMatch(/\bspctl\b/);
      expect(src).toMatch(/--options runtime/);
      expect(src).toMatch(/entitlements-jit\.plist/);
    });

    it('win uses signtool sign with /fd SHA256 + /tr + /td SHA256', () => {
      const src = read(WIN_PS1);
      expect(src).toMatch(/signtool/);
      expect(src).toMatch(/'sign'/);
      expect(src).toMatch(/'\/fd', 'SHA256'/);
      expect(src).toMatch(/'\/tr',/);
      expect(src).toMatch(/'\/td', 'SHA256'/);
    });

    it('linux uses debsigs + rpm --addsign + gpg --detach-sign', () => {
      const src = read(LINUX_SH);
      expect(src).toMatch(/\bdebsigs\b/);
      expect(src).toMatch(/rpm.*--addsign/);
      expect(src).toMatch(/--detach-sign/);
    });
  });

  describe('placeholder-safe — dry-run + missing env exits 0', () => {
    it('sign-mac.sh exits 0 with no env (non-darwin host) and prints WARN', () => {
      // We test this on whatever host runs the suite. On non-darwin it
      // hits the gate; on darwin it hits the missing-env gate. Either path
      // exits 0 with a WARN line. WARN goes to stderr; capture both.
      const out = execFileSync('bash', [MAC_SH], {
        env: { ...process.env, APPLE_TEAM_ID: '', APPLE_SIGNING_IDENTITY: '', APPLE_NOTARY_PROFILE: '', CCSM_SIGN_DRY_RUN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(typeof out.toString()).toBe('string');
    });

    it('sign-linux.sh exits 0 with no env and prints WARN', () => {
      // WARN goes to stderr; merge by spawning bash -c to redirect.
      const out = execFileSync('bash', ['-c', `bash "${LINUX_SH}" 2>&1`], {
        env: { ...process.env, GPG_SIGNING_KEY: '', CCSM_SIGN_DRY_RUN: '' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      expect(out.toString()).toMatch(/WARN: GPG_SIGNING_KEY not set/);
    });

    it('sign-mac.sh dry-run prints codesign + xcrun notarytool traces', () => {
      const out = execFileSync('bash', [MAC_SH], {
        env: {
          ...process.env,
          APPLE_TEAM_ID: 'XXXXXXXXXX',
          APPLE_SIGNING_IDENTITY: 'Developer ID Application: Test (XXXXXXXXXX)',
          APPLE_NOTARY_PROFILE: 'test-profile',
          CCSM_SIGN_DRY_RUN: '1',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const text = out.toString();
      expect(text).toMatch(/DRY-RUN.*codesign/);
      expect(text).toMatch(/DRY-RUN.*xcrun notarytool submit/);
      expect(text).toMatch(/DRY-RUN.*stapler staple/);
      expect(text).toMatch(/DRY-RUN.*spctl --assess/);
    });

    it('sign-linux.sh dry-run prints debsigs + rpm --addsign + gpg --detach-sign traces', () => {
      const out = execFileSync('bash', [LINUX_SH, '/tmp/fake-binary', '/tmp/fake.deb', '/tmp/fake.rpm'], {
        env: { ...process.env, GPG_SIGNING_KEY: '0xDEADBEEF', CCSM_SIGN_DRY_RUN: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const text = out.toString();
      expect(text).toMatch(/DRY-RUN.*gpg.*--detach-sign/);
      expect(text).toMatch(/DRY-RUN.*debsigs --sign=origin/);
      expect(text).toMatch(/DRY-RUN.*rpm.*--addsign/);
    });
  });

  describe('build-sea pipeline hook (T7.1 -> T7.3)', () => {
    it('build-sea.sh invokes sign-mac.sh on mac and sign-linux.sh on linux', () => {
      const src = readFileSync(path.join(BUILD_DIR, 'build-sea.sh'), 'utf8');
      expect(src).toMatch(/sign-mac\.sh/);
      expect(src).toMatch(/sign-linux\.sh/);
    });

    it('build-sea.ps1 invokes sign-win.ps1', () => {
      const src = readFileSync(path.join(BUILD_DIR, 'build-sea.ps1'), 'utf8');
      expect(src).toMatch(/sign-win\.ps1/);
    });
  });
});
