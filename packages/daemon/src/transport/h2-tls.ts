// h2 over loopback TLS — spec ch03 §4 option A3.
//
// Last-resort Listener A transport: only used when h2c is unsupported
// by a future Connect server pin or when an OS hardens loopback
// against plaintext h2c. v0.3 ships this adapter so the descriptor
// writer (T1.6) and the Electron transport factory (T2.x) have the
// `KIND_TCP_LOOPBACK_H2_TLS` code path exercised by tests, even
// though no spec'd OS picks it as the default.
//
// TLS is "self-signed local cert" per spec ch03 §4 A3 — Electron pins
// the cert's SHA-256 fingerprint via the descriptor's
// `tlsCertFingerprintSha256` field (spec ch03 §3.2) rather than
// trusting any OS root store. The adapter therefore EXPOSES the
// fingerprint (computed from the supplied cert PEM) as part of
// `BoundAddress` so the descriptor writer can pin it without re-
// parsing the cert.
//
// Cert provisioning: NOT this adapter's job. The installer / startup
// code mints + rotates the self-signed cert (spec ch10 §3 referenced
// from ch03 §4 A3); this adapter is the bind primitive that consumes
// the resulting PEM bytes.
//
// Layer 1: node: stdlib only (`node:crypto`, `node:tls` indirectly via
// the `Http2SecureServer` the caller built with `http2.createSecureServer`).

import { createHash, X509Certificate } from 'node:crypto';

import type {
  BoundAddress,
  BoundTransport,
  H2TlsServer,
  TlsBindSpec,
} from './types.js';

/**
 * Compute the SHA-256 fingerprint of a PEM-encoded X.509 cert as a
 * lowercase hex string with no separators (matches the descriptor
 * field's contract — spec ch03 §3.2).
 *
 * Fingerprint is over the DER-encoded cert (the standard cert pinning
 * input), not the PEM bytes — `X509Certificate.raw` is the DER form.
 */
export function computeCertFingerprint(certPem: string | Buffer): string {
  // X509Certificate accepts PEM or DER; `.raw` always returns DER.
  const cert = new X509Certificate(certPem);
  return createHash('sha256').update(cert.raw).digest('hex');
}

/**
 * Bind the supplied http2 secure server to `spec.host:spec.port`.
 * Resolves once `listening` fires.
 *
 * The cert + key supplied via `spec` are assumed to already be installed
 * on the server (the caller built the `Http2SecureServer` with them).
 * We re-derive the fingerprint here from `spec.cert` so the
 * `BoundAddress.certFingerprintSha256` reflects the actual cert in use
 * — there is no ambient API on `Http2SecureServer` to read the bound
 * cert back, and inferring it via TLS-context introspection is brittle.
 */
export async function bindH2Tls(
  server: H2TlsServer,
  spec: TlsBindSpec,
): Promise<BoundTransport> {
  if (spec.host !== '127.0.0.1') {
    throw new Error(
      `h2-TLS host MUST be 127.0.0.1 (got ${String(spec.host)}); spec ch03 §1a closed enum.`,
    );
  }
  if (!Number.isInteger(spec.port) || spec.port < 0 || spec.port > 65535) {
    throw new Error(`h2-TLS port out of range: ${spec.port}`);
  }

  const fingerprint = computeCertFingerprint(spec.cert);

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = (): void => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen({ host: spec.host, port: spec.port });
  });

  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('http2 secure server.address() returned unexpected shape after listen');
  }
  const boundPort = addr.port;

  const address = (): BoundAddress => ({
    kind: 'KIND_TCP_LOOPBACK_H2_TLS',
    host: '127.0.0.1',
    port: boundPort,
    certFingerprintSha256: fingerprint,
  });

  let closed = false;
  let closePromise: Promise<void> | null = null;
  const close = async (): Promise<void> => {
    if (closed) return closePromise ?? Promise.resolve();
    closed = true;
    closePromise = new Promise<void>((resolve, reject) => {
      server.close((err) => {
        if (err) reject(err);
        else resolve();
      });
    });
    return closePromise;
  };

  return { address, close };
}
