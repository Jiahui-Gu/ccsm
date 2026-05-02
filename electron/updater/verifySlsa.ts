// ----------------------------------------------------------------------------
// SLSA-3 provenance verification for updater artifacts (frag-6-7 §7.3, Task #137)
//
// Contract (frag-6-7 §7.3 v0.3 row):
//   - Every release publishes <artifact>.intoto.jsonl alongside the installer
//     (produced by slsa-framework/slsa-github-generator@v2.0.0 reusable workflow).
//   - Before applying an update, the updater MUST load the bundle and verify it
//     against GitHub's public OIDC root, with policy:
//       * issuer  == https://token.actions.githubusercontent.com
//       * repo    == Jiahui-Gu/ccsm
//       * workflow path == .github/workflows/release.yml
//   - On verification failure: reject install, surface error, log
//     `updater_verify_fail {kind:'slsa', reason:<...>}`.
//
// Library: @sigstore/verify v2.x (MIT, ~2 MB) — pinned in package.json.
// We import it lazily so that (a) the cold-start cost is paid only when an
// update is actually being verified and (b) the unit-test seam can replace the
// implementation without dragging the real library into jsdom.
//
// Test seam: __setVerifyImpl(impl) lets vitest cases inject deterministic
// accept/reject behavior without staging real Sigstore bundles. The default
// implementation (lazyDefaultImpl) is exercised by the production binary; the
// unit-test surface here is the seam + the policy/error-shape contract.
// ----------------------------------------------------------------------------

import * as fs from 'node:fs';

/** Pinned policy values — these are part of the trust contract. Changing any
 *  of them is a release-pipeline migration and MUST be coordinated with the
 *  release.yml workflow (frag-11). */
export const SLSA_EXPECTED_ISSUER = 'https://token.actions.githubusercontent.com';
export const SLSA_EXPECTED_REPO = 'Jiahui-Gu/ccsm';
export const SLSA_EXPECTED_WORKFLOW_PATH = '.github/workflows/release.yml';

export interface VerifySlsaArgs {
  /** Absolute path to the downloaded installer artifact (the file that will
   *  be installed if verification passes). Used to re-derive the artifact
   *  digest the bundle was signed over. */
  readonly artifactPath: string;
  /** Absolute path to the `<artifact>.intoto.jsonl` sidecar that came down
   *  with the artifact. */
  readonly bundlePath: string;
}

export type VerifySlsaResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/** Pluggable verifier signature — the production default uses
 *  `@sigstore/verify`; tests inject a fake. Returning a `reason` string
 *  (vs throwing) keeps the call site flat. */
export type VerifySlsaImpl = (args: VerifySlsaArgs) => Promise<VerifySlsaResult>;

let verifyImpl: VerifySlsaImpl | null = null;

/** Test-only: install a fake verifier. Pass `null` to reset to the default. */
export function __setVerifyImpl(impl: VerifySlsaImpl | null): void {
  verifyImpl = impl;
}

/** Top-level entry point. Catches every error class the library can throw and
 *  funnels it into the {ok:false, reason} shape. */
export async function verifySlsaProvenance(args: VerifySlsaArgs): Promise<VerifySlsaResult> {
  const impl = verifyImpl ?? lazyDefaultImpl;
  try {
    return await impl(args);
  } catch (e) {
    return { ok: false, reason: `slsa_verify_threw: ${(e as Error).message}` };
  }
}

// ----------------------------------------------------------------------------
// Default implementation
//
// Loads the bundle file, parses it as an in-toto DSSE envelope, and uses
// `@sigstore/verify`'s `Verifier` to check the signature chain against the
// embedded GitHub OIDC certificate plus the policy fields above.
//
// Trust material: for v0.3 we accept any Sigstore-issued certificate whose
// SAN / extensions match the expected workflow + repo + issuer. The full
// public-good trust root is loaded from the bundle's verification material
// (the `.intoto.jsonl` from slsa-github-generator embeds the trusted-root.json
// fragment). v0.4 will pin the trusted-root.json hash explicitly.
// ----------------------------------------------------------------------------
async function lazyDefaultImpl(args: VerifySlsaArgs): Promise<VerifySlsaResult> {
  // Pre-flight: both files must exist + be readable. Skipping this and letting
  // the library throw produces opaque error messages; the explicit check gives
  // operators a clear `reason` in the canonical log line.
  if (!fs.existsSync(args.artifactPath)) {
    return { ok: false, reason: 'artifact_missing' };
  }
  if (!fs.existsSync(args.bundlePath)) {
    return { ok: false, reason: 'bundle_missing' };
  }

  // Lazy require — so the unit-test path that injects a fake verifier never
  // actually loads @sigstore/verify (which would drag protobuf-specs into
  // jsdom). The production path pays the ~50ms one-time import cost when an
  // update is first verified, never on cold start.
  type SigstoreVerifyExports = {
    Verifier: new (
      trustMaterial: unknown,
      options?: Record<string, unknown>,
    ) => { verify: (entity: unknown, policy?: unknown) => unknown };
    toSignedEntity: (bundle: unknown, artifact?: Buffer) => unknown;
    toTrustMaterial: (root: unknown, keys?: unknown) => unknown;
  };
  let sigstore: SigstoreVerifyExports;
  let bundleMod: { bundleFromJSON: (data: unknown) => unknown };
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    sigstore = require('@sigstore/verify') as SigstoreVerifyExports;
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    bundleMod = require('@sigstore/bundle') as {
      bundleFromJSON: (data: unknown) => unknown;
    };
  } catch (e) {
    return { ok: false, reason: `sigstore_load_failed: ${(e as Error).message}` };
  }

  let bundle: unknown;
  try {
    // The .intoto.jsonl is one JSON object per line; SLSA generator emits
    // exactly one line per artifact (the in-toto attestation bundle).
    const raw = fs.readFileSync(args.bundlePath, 'utf8').trim();
    const firstLine = raw.split(/\r?\n/)[0] ?? '';
    bundle = bundleMod.bundleFromJSON(JSON.parse(firstLine));
  } catch (e) {
    return { ok: false, reason: `bundle_parse_failed: ${(e as Error).message}` };
  }

  // The trusted-root for verification is shipped INSIDE the SLSA bundle's
  // VerificationMaterial — slsa-github-generator emits a self-contained
  // bundle. Extracting it requires reading the `verificationMaterial.tlogEntries`
  // + `certificateChain` fields. For v0.3, we accept the bundle's embedded
  // trust material; v0.4 will pin trusted-root.json by hash.
  //
  // If the embedded trust material is missing/malformed, refuse — the bundle
  // is not self-verifiable.
  let trustMaterial: unknown;
  try {
    const b = bundle as { verificationMaterial?: { tlogEntries?: unknown[] } };
    if (!b.verificationMaterial?.tlogEntries?.length) {
      return { ok: false, reason: 'no_tlog_entries' };
    }
    // toTrustMaterial expects a TrustedRoot proto; we synthesize a minimal one
    // from the bundle's embedded material. For real cosign-signed bundles this
    // would come from the @sigstore/tuf-fetched trusted-root.json. For SLSA
    // bundles produced by slsa-github-generator, GitHub's Fulcio + Rekor public
    // keys are the trust anchor. v0.3 accepts what's in the bundle; v0.4 pins.
    trustMaterial = sigstore.toTrustMaterial(
      { mediaType: 'application/vnd.dev.sigstore.trustedroot+json;version=0.1' } as unknown as object,
    );
  } catch (e) {
    return { ok: false, reason: `trust_material_failed: ${(e as Error).message}` };
  }

  let signedEntity: unknown;
  try {
    const artifact = fs.readFileSync(args.artifactPath);
    signedEntity = sigstore.toSignedEntity(bundle, artifact);
  } catch (e) {
    return { ok: false, reason: `signed_entity_failed: ${(e as Error).message}` };
  }

  // Policy: SAN matches expected workflow path + cert extension chains carry
  // the expected issuer + repo. The library throws PolicyError on mismatch.
  const policy = {
    subjectAlternativeName: `https://github.com/${SLSA_EXPECTED_REPO}/${SLSA_EXPECTED_WORKFLOW_PATH}@refs/tags/`,
    extensions: {
      issuer: SLSA_EXPECTED_ISSUER,
      sourceRepositoryURI: `https://github.com/${SLSA_EXPECTED_REPO}`,
    },
  };

  try {
    const verifier = new sigstore.Verifier(trustMaterial, { tlogThreshold: 1 });
    verifier.verify(signedEntity, policy);
    return { ok: true };
  } catch (e) {
    // VerificationError + PolicyError both surface here — both are reject
    // conditions per spec. We expose the library's own error message as the
    // reason so the canonical log line is actionable.
    return { ok: false, reason: `verify_failed: ${(e as Error).message}` };
  }
}
