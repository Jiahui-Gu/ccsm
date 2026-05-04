/**
 * tools/test/verify-signing.spec.ts
 *
 * Spec: docs/superpowers/specs/2026-05-03-v03-daemon-split-design.md ch10 §7.
 * Task #80 (T7.9) — per-OS signature verification scripts (companion to
 * Task #82 / T7.3 sign-* scripts).
 *
 * Forever-stable shape gate for tools/verify-signing.{sh,ps1}. We assert:
 *
 *   1. Both files exist at the spec-pinned paths (ch10 §7 last paragraph
 *      and ch11 §2 directory layout pin them under tools/).
 *   2. Each script invokes the verification tools the spec pins per OS:
 *        - mac:   codesign --verify --deep --strict + spctl --assess
 *        - linux: dpkg-sig --verify (GOODSIG) + rpm --checksig + gpg --verify
 *        - win:   Get-AuthenticodeSignature + Status -eq 'Valid'
 *                 + TimeStamperCertificate
 *   3. The forever-stable env contract appears in each script:
 *        - CCSM_VERIFY_SIGNING_STRICT (placeholder-safe vs CI-strict toggle)
 *        - CCSM_EXPECTED_CERT_CN      (cert pinning hook)
 *   4. Cross-host placeholder-safe behavior: the bash script invoked with
 *      no inputs and no STRICT env exits 0 with a WARN (does not break
 *      local dogfood `npm run build` smoke).
 *
 * Heavy real-cert / real-MSI verification lives in CI release jobs; this
 * spec is the cheapest forever-stable contract per dev §2 quality gates.
 *
 * Run with:
 *   npx vitest run --config tools/vitest.config.ts \
 *     tools/test/verify-signing.spec.ts
 */

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SH = join(REPO_ROOT, 'tools', 'verify-signing.sh');
const PS1 = join(REPO_ROOT, 'tools', 'verify-signing.ps1');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('tools/verify-signing.{sh,ps1} (spec ch10 §7, T7.9)', () => {
  describe('files exist at spec-pinned paths', () => {
    it('tools/verify-signing.sh present', () => {
      expect(existsSync(SH)).toBe(true);
    });
    it('tools/verify-signing.ps1 present', () => {
      expect(existsSync(PS1)).toBe(true);
    });
  });

  describe('per-OS verification tool pins (spec ch10 §7)', () => {
    it('verify-signing.sh mac branch invokes codesign --verify + spctl --assess', () => {
      const src = read(SH);
      expect(src).toMatch(/codesign --verify --deep --strict --verbose=4/);
      expect(src).toMatch(/spctl --assess --type/);
      // Spec asserts output contains "accepted".
      expect(src).toMatch(/"accepted"/);
    });

    it('verify-signing.sh linux branch invokes dpkg-sig + rpm --checksig + gpg --verify', () => {
      const src = read(SH);
      expect(src).toMatch(/dpkg-sig --verify/);
      // Spec literal: GOODSIG.
      expect(src).toContain('GOODSIG');
      expect(src).toMatch(/rpm --checksig -v/);
      // Spec literals: "Header SHA256 digest: OK" and the "Header V4 .../SHA256 Signature, key ID ...: OK" line.
      expect(src).toContain('Header SHA256 digest: OK');
      expect(src).toMatch(/Header V4.*SHA256 Signature.*key ID.*OK/);
      expect(src).toMatch(/gpg --verify/);
    });

    it('verify-signing.ps1 invokes Get-AuthenticodeSignature with Status/TimeStamper assertions', () => {
      const src = read(PS1);
      expect(src).toMatch(/Get-AuthenticodeSignature/);
      // Spec assertions.
      expect(src).toMatch(/Status\s*-ne\s*'Valid'|Status\s*-eq\s*'Valid'/);
      expect(src).toMatch(/TimeStamperCertificate/);
      expect(src).toMatch(/SignerCertificate\.Subject/);
    });
  });

  describe('forever-stable env contract', () => {
    it('verify-signing.sh references CCSM_VERIFY_SIGNING_STRICT + CCSM_EXPECTED_CERT_CN', () => {
      const src = read(SH);
      expect(src).toContain('CCSM_VERIFY_SIGNING_STRICT');
      expect(src).toContain('CCSM_EXPECTED_CERT_CN');
    });

    it('verify-signing.ps1 references CCSM_VERIFY_SIGNING_STRICT + CCSM_EXPECTED_CERT_CN', () => {
      const src = read(PS1);
      expect(src).toContain('CCSM_VERIFY_SIGNING_STRICT');
      expect(src).toContain('CCSM_EXPECTED_CERT_CN');
    });
  });

  describe('placeholder-safe — exits 0 + WARN with no env / no inputs', () => {
    // Cross-host placeholder gate: every CI matrix runner exercises this
    // before its host-specific job. Mirrors the contract from
    // packages/daemon/build/__tests__/sign-scripts.spec.ts (Task #82).
    it('verify-signing.sh exits 0 + prints WARN when no artifacts and STRICT unset', () => {
      const proc = spawnSync(
        'bash',
        ['-c', `bash "${SH}" --binary /nonexistent-${Date.now()} --native /nonexistent-${Date.now()} 2>&1`],
        {
          env: {
            ...process.env,
            CCSM_VERIFY_SIGNING_STRICT: '',
            CCSM_EXPECTED_CERT_CN: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const out = (proc.stdout?.toString() ?? '') + (proc.stderr?.toString() ?? '');
      expect(proc.status, `expected exit 0, got ${proc.status}. output:\n${out}`).toBe(0);
      expect(out).toMatch(/WARN:/);
    });

    it('verify-signing.sh STRICT=1 hard-fails (exit 30) when no artifacts present', () => {
      const proc = spawnSync(
        'bash',
        ['-c', `bash "${SH}" --binary /nonexistent-${Date.now()} --native /nonexistent-${Date.now()} 2>&1`],
        {
          env: {
            ...process.env,
            CCSM_VERIFY_SIGNING_STRICT: '1',
            CCSM_EXPECTED_CERT_CN: '',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      const out = (proc.stdout?.toString() ?? '') + (proc.stderr?.toString() ?? '');
      // Strict mode must surface a non-zero exit; 30 is the documented
      // "missing tooling / wrong host / missing input" code.
      expect(proc.status, `expected non-zero exit, got ${proc.status}. output:\n${out}`).not.toBe(0);
      expect(out).toMatch(/FAIL:/);
    });
  });

  describe('CI invocation site (spec ch10 §7)', () => {
    // The spec pins these scripts as gating in package-* jobs. The actual
    // wiring lives in the future T0.9 / package-* CI jobs (mutex-blocked
    // per sign-mac.sh comment). The forever-stable contract this test
    // protects is just that the scripts exist with executable shebangs so
    // a `run: bash tools/verify-signing.sh` step works in any matrix.
    it('verify-signing.sh has bash shebang', () => {
      const src = read(SH);
      expect(src.split('\n')[0]).toBe('#!/usr/bin/env bash');
    });
  });
});
