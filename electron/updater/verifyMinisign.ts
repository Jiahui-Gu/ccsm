// ----------------------------------------------------------------------------
// Linux minisign verification for updater artifacts (frag-6-7 §7.3, Task #137)
//
// Contract (frag-6-7 §7.3 v0.3 row, release-keys/README.md):
//   - Linux releases publish <artifact>.minisig alongside the installer,
//     signed in CI by the key whose private half is the GitHub Actions secret
//     MINISIGN_PRIVATE_KEY.
//   - Updater MUST shell out to `minisign -V -p <pinned-pubkey> -m <artifact>`
//     before applying an update. On non-zero exit: reject install, surface
//     error, log `updater_verify_fail {kind:'minisign', reason:<...>}`.
//   - Linux-only: macOS uses codesign + notarization, Windows uses signtool.
//     On those platforms this verifier is a no-op (`{ok:true}` short-circuit
//     so the caller can stay platform-agnostic).
//
// Minisign binary discovery: the production daemon expects a `minisign`
// executable on PATH. v0.3 documents this as a Linux user pre-req in the
// updater README; v0.4 will ship a static minisign binary inside the AppImage.
// On Linux without minisign installed, verification fails closed with
// reason='minisign_binary_missing' — refusing to install rather than
// silently bypassing the check.
// ----------------------------------------------------------------------------

import { spawn, type SpawnOptions } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// ----------------------------------------------------------------------------
// Pinned public key (frag-6-7 §7.3, release-keys/minisign.pub)
//
// Key ID:      D1146C005BA0E1F3
// Public key:  RWTz4aBbAGwU0RyPzS5uDEFeoFoLMCxaFMhjMYPAyYYK5pbHvKNREKIX
//
// Hardcoded here AND committed to release-keys/minisign.pub. The two MUST
// match — a CI smoke test (TODO frag-11) compares them. Hardcoding it in
// the source means an attacker who tampers with the on-disk pubkey file
// (e.g. via a malicious installer that drops a different release-keys/
// directory) cannot redirect verification to a key they control.
//
// Rotation procedure: see release-keys/README.md "Key rotation". Updating
// this constant + release-keys/minisign.pub is one PR; the key MUST be
// rotated before the GitHub Actions secret MINISIGN_PRIVATE_KEY is updated
// or the next release will fail verification on every user's machine.
// ----------------------------------------------------------------------------
export const MINISIGN_PUBKEY_LINES = [
  'untrusted comment: minisign public key D1146C005BA0E1F3',
  'RWTz4aBbAGwU0RyPzS5uDEFeoFoLMCxaFMhjMYPAyYYK5pbHvKNREKIX',
];

export const MINISIGN_PUBKEY = MINISIGN_PUBKEY_LINES.join('\n') + '\n';

/** SHA-256 fingerprint of the pubkey file content — the operational handle
 *  surfaced in release notes on rotation. Computed lazily so tests don't pull
 *  crypto into module init time. */
export function minisignPubkeyFingerprint(): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const crypto = require('node:crypto') as typeof import('node:crypto');
  return crypto.createHash('sha256').update(MINISIGN_PUBKEY).digest('hex');
}

export interface VerifyMinisignArgs {
  /** Absolute path to the downloaded installer artifact. */
  readonly artifactPath: string;
  /** Absolute path to the `<artifact>.minisig` sidecar. */
  readonly signaturePath: string;
  /** Override platform check (tests). When unset, uses `process.platform`. */
  readonly platform?: NodeJS.Platform;
}

export type VerifyMinisignResult =
  | { readonly ok: true; readonly skipped?: 'non-linux' }
  | { readonly ok: false; readonly reason: string };

/** Pluggable minisign runner — production spawns the system `minisign`
 *  binary; tests inject a synchronous fake. Returns the exit code + captured
 *  stderr so the caller can shape the canonical log line. */
export type MinisignRunner = (
  binary: string,
  args: readonly string[],
  options: SpawnOptions,
) => Promise<{ readonly code: number; readonly stderr: string }>;

let runnerImpl: MinisignRunner | null = null;

/** Test-only: install a fake runner. Pass `null` to reset to the default
 *  (real `child_process.spawn`). */
export function __setMinisignRunner(runner: MinisignRunner | null): void {
  runnerImpl = runner;
}

/** Top-level entry point. Always Linux-gated so callers can invoke
 *  unconditionally; on macOS/Windows this returns `{ok:true, skipped:...}`. */
export async function verifyMinisign(
  args: VerifyMinisignArgs,
): Promise<VerifyMinisignResult> {
  const platform = args.platform ?? process.platform;
  if (platform !== 'linux') {
    // macOS + Windows have their own signing chains (codesign/signtool); the
    // minisign sidecar is not produced on those targets by release.yml.
    return { ok: true, skipped: 'non-linux' };
  }

  if (!fs.existsSync(args.artifactPath)) {
    return { ok: false, reason: 'artifact_missing' };
  }
  if (!fs.existsSync(args.signaturePath)) {
    return { ok: false, reason: 'signature_missing' };
  }

  // Materialize the pinned pubkey to a temp file. We do NOT trust an on-disk
  // copy under release-keys/ at runtime, because the running Electron app's
  // resource layout is attacker-influenced post-install (a malicious replacer
  // could swap the .pub file). The hardcoded constant is the single source of
  // truth; minisign needs a file path, so we write it fresh per verification
  // into the OS temp dir and clean up after.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccsm-minisign-'));
  const pubKeyPath = path.join(tmpDir, 'minisign.pub');
  try {
    fs.writeFileSync(pubKeyPath, MINISIGN_PUBKEY, { mode: 0o600 });

    const runner = runnerImpl ?? defaultRunner;
    const { code, stderr } = await runner(
      'minisign',
      ['-V', '-p', pubKeyPath, '-x', args.signaturePath, '-m', args.artifactPath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    if (code === 0) return { ok: true };
    // Distinguish "binary not found" from "signature mismatch" so the
    // canonical log line is actionable. ENOENT bubbles up as code -2 in
    // Node's child_process default error channel.
    if (code === -2 || /ENOENT/i.test(stderr)) {
      return { ok: false, reason: 'minisign_binary_missing' };
    }
    return { ok: false, reason: `minisign_exit_${code}: ${stderr.trim().slice(0, 200)}` };
  } catch (e) {
    return { ok: false, reason: `minisign_threw: ${(e as Error).message}` };
  } finally {
    // Best-effort cleanup; OS temp eviction is the safety net.
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore — temp dir cleanup is not load-bearing for the verify result.
    }
  }
}

const defaultRunner: MinisignRunner = (binary, args, options) =>
  new Promise((resolve) => {
    let stderr = '';
    let resolved = false;
    const child = spawn(binary, [...args], options);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      if (resolved) return;
      resolved = true;
      // ENOENT => binary missing; surface as code -2 to match the caller's
      // detection logic above. Any other spawn-level error is also fatal.
      const code = err.code === 'ENOENT' ? -2 : 1;
      resolve({ code, stderr: stderr || err.message });
    });
    child.on('exit', (code) => {
      if (resolved) return;
      resolved = true;
      resolve({ code: code ?? 1, stderr });
    });
  });
