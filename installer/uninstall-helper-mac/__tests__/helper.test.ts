// Wiring smoke test for ccsm-uninstall-helper Mach-O build (Task #136 /
// frag-11 §11.6.4).
//
// The actual Mach-O verification (single-arch + universal CAFEBABE)
// happens inside scripts/build-mac-uninstall-helper.sh on a macOS runner
// — that script is the authoritative quality gate (it shells out to
// `file` and `xxd` on the freshly-built binaries). Running swiftc inside
// vitest on Linux/Win CI is not possible.
//
// What this file DOES check (catches regressions that would otherwise
// only surface on the mac runner):
//   1. The Swift source exists at the expected path.
//   2. The Swift source declares the public functions the build script
//      assumes are there (parseArgs, decideActions, resolveDataRoot,
//      executeActions). A rename without updating the build script /
//      this test is what we want to catch.
//   3. The build script exists, is executable-shaped (#!/usr/bin/env
//      bash + set -euo pipefail), and references the Swift source at
//      the exact path the source lives at.
//   4. The build script asserts CAFEBABE for the universal output (the
//      task's spec language) — a refactor that drops the magic check
//      would let a broken lipo invocation through.
//   5. The data-root path uses lowercase `ccsm` per task #132 — uppercase
//      `CCSM` here would diverge from the daemon's own dataRoot
//      computation and the helper would target the wrong directory.

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SWIFT_SRC = resolve(REPO_ROOT, 'installer/uninstall-helper-mac/ccsm-uninstall-helper.swift');
const BUILD_SCRIPT = resolve(REPO_ROOT, 'scripts/build-mac-uninstall-helper.sh');

describe('mac-uninstall-helper / files exist', () => {
  it('Swift source is present at the expected path', () => {
    expect(existsSync(SWIFT_SRC)).toBe(true);
  });

  it('build script is present at the expected path', () => {
    expect(existsSync(BUILD_SCRIPT)).toBe(true);
  });
});

describe('mac-uninstall-helper / Swift source shape', () => {
  const src = existsSync(SWIFT_SRC) ? readFileSync(SWIFT_SRC, 'utf8') : '';

  it('declares the four SRP-split functions (PRODUCER/DECIDER/SINK)', () => {
    // PRODUCER: parseArgs + resolveDataRoot
    expect(src).toMatch(/func parseArgs\(/);
    expect(src).toMatch(/func resolveDataRoot\(/);
    // DECIDER: decideActions (pure, takes FSProbe abstraction)
    expect(src).toMatch(/func decideActions\(/);
    expect(src).toMatch(/protocol FSProbe/);
    // SINK: executeActions over a Sink protocol
    expect(src).toMatch(/func executeActions\(/);
    expect(src).toMatch(/protocol Sink/);
  });

  it('uses lowercase `ccsm` in the data root path (task #132)', () => {
    // The data root MUST match the daemon's own
    // `~/Library/Application Support/ccsm/` (frag-11 §11.6 paths
    // table). Uppercase `CCSM` here would silently target the wrong
    // directory and the helper would do nothing.
    expect(src).toMatch(/Library\/Application Support\/ccsm/);
    expect(src).not.toMatch(/Library\/Application Support\/CCSM/);
  });

  it('uses POSIX kill(2) for SIGTERM-then-SIGKILL semantics', () => {
    // Linux postrm equivalent — see frag-11 §11.6.3. SIGTERM first, then
    // SIGKILL after grace period. A regression to plain SIGKILL would
    // skip the daemon's pino flush + sqlite checkpoint.
    expect(src).toMatch(/SIGTERM/);
    expect(src).toMatch(/SIGKILL/);
  });

  it('cleans up BOTH daemon.lock and daemon.lock.lock (Task #154)', () => {
    // Cross-ref daemon/src/lifecycle/lockfile.ts "External PID source
    // contract": the regular file daemon.lock holds the PID payload AND
    // proper-lockfile mkdirs daemon.lock.lock as the atomic gate. The
    // helper MUST clean both — leaving the `.lock` directory triggers a
    // noisy `lockfile_steal` warn on next boot. Test asserts both the
    // suffix concatenation and the directoryExists probe are present.
    expect(src).toMatch(/let lockDirPath = "\\\(lockPath\)\.lock"/);
    expect(src).toMatch(/directoryExists/);
    expect(src).toMatch(/removeTree\(path: lockDirPath\)/);
  });

  it('has a pgrep -f fallback when PID payload missing (Task #154)', () => {
    // Mirrors build/linux-postrm.sh `pkill -f` fallback. Without this,
    // a daemon that crashed before stamping its PID payload (proper-
    // lockfile mkdir succeeded but PID write didn't) would silently
    // survive the uninstall.
    expect(src).toMatch(/pgrepKill/);
    expect(src).toMatch(/DAEMON_PGREP_PATTERN/);
    expect(src).toMatch(/ccsm-daemon/);
  });

  it('has --purge as opt-in (default = retain user data)', () => {
    // Matches frag-11 §11.6 paths table "Cleanup default = retained" for
    // data/, logs/, crashes/, daemon.secret. Default-purge would be a
    // dataloss regression.
    expect(src).toMatch(/var purge: Bool = false/);
  });

  it('has --dry-run for the CI smoke gate', () => {
    expect(src).toMatch(/var dryRun: Bool = false/);
  });
});

describe('mac-uninstall-helper / build script shape', () => {
  const sh = existsSync(BUILD_SCRIPT) ? readFileSync(BUILD_SCRIPT, 'utf8') : '';

  it('uses strict bash mode (#!/usr/bin/env bash + set -euo pipefail)', () => {
    expect(sh).toMatch(/^#!\/usr\/bin\/env bash/);
    expect(sh).toMatch(/set -euo pipefail/);
  });

  it('references the Swift source at the exact path the source lives at', () => {
    expect(sh).toMatch(/installer\/uninstall-helper-mac\/ccsm-uninstall-helper\.swift/);
  });

  it('produces all three artifacts (x64, arm64, universal)', () => {
    expect(sh).toMatch(/ccsm-uninstall-helper-macos-x64/);
    expect(sh).toMatch(/ccsm-uninstall-helper-macos-arm64/);
    expect(sh).toMatch(/ccsm-uninstall-helper-macos-universal/);
  });

  it('verifies the universal binary CAFEBABE magic explicitly', () => {
    // Spec frag-11 §11.6.4 + task brief: universal binary must report
    // CAFEBABE magic. A refactor that drops this check would let lipo
    // silently produce a thin binary tagged with the universal name.
    expect(sh).toMatch(/cafebabe/i);
    expect(sh).toMatch(/Mach-O universal binary/);
  });

  it('verifies thin binaries report the correct arch', () => {
    expect(sh).toMatch(/Mach-O 64-bit executable/);
    expect(sh).toMatch(/x86_64/);
    expect(sh).toMatch(/arm64/);
  });

  it('platform-gates to Darwin', () => {
    // Other matrix legs (linux/windows) MUST NOT try to run swiftc; the
    // script should fail fast with a clear message.
    expect(sh).toMatch(/uname -s.*Darwin|Darwin.*uname -s/);
  });
});
