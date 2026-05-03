// h2-TLS adapter spec — exercises cert fingerprint computation +
// bind / address / close on a real loopback TLS listener with a
// transient self-signed cert. Spec ch03 §4 A3.

import { afterEach, describe, expect, it } from 'vitest';
import {
  createSecureServer,
  connect as h2connect,
  type ClientHttp2Session,
} from 'node:http2';
import { createHash, X509Certificate } from 'node:crypto';
import { execSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { bindH2Tls, computeCertFingerprint } from '../h2-tls.js';
import type { BoundTransport } from '../types.js';

let bound: BoundTransport | null = null;
let h2client: ClientHttp2Session | null = null;

afterEach(async () => {
  if (h2client) {
    h2client.destroy();
    h2client = null;
  }
  if (bound) {
    await bound.close();
    bound = null;
  }
});

// Mint a self-signed cert at MODULE LOAD time (synchronous) so
// `it.skipIf(!HAVE_CERT)` evaluates correctly at collect time.
//
// Path: shell out to `openssl req` if openssl is on PATH; otherwise
// skip every test in this suite. The skip path is acceptable per
// spec ch03 §4 A3 — A3 is the last-resort transport, exercised in
// dev / CI where openssl is ubiquitous. Production cert provisioning
// is the installer's job (T7.5), not this adapter's.
let TEST_CERT_PEM = '';
let TEST_KEY_PEM = '';
let TEST_CERT_FINGERPRINT = '';
let HAVE_CERT = false;

try {
  execSync('openssl version', { stdio: 'ignore' });
  const dir = mkdtempSync(join(tmpdir(), 'ccsm-h2-tls-'));
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  execSync(
    `openssl req -x509 -newkey rsa:2048 -nodes -keyout "${keyPath}" -out "${certPath}" -days 3650 -subj "/CN=localhost" -addext "subjectAltName=IP:127.0.0.1"`,
    { stdio: 'ignore' },
  );
  TEST_KEY_PEM = readFileSync(keyPath, 'utf8');
  TEST_CERT_PEM = readFileSync(certPath, 'utf8');
  const cert = new X509Certificate(TEST_CERT_PEM);
  TEST_CERT_FINGERPRINT = createHash('sha256').update(cert.raw).digest('hex');
  HAVE_CERT = true;
} catch {
  HAVE_CERT = false;
}

describe('computeCertFingerprint', () => {
  it.skipIf(!HAVE_CERT)('matches the SHA-256 of the DER form of the cert', () => {
    const fp = computeCertFingerprint(TEST_CERT_PEM);
    expect(fp).toBe(TEST_CERT_FINGERPRINT);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
  });

  it.skipIf(!HAVE_CERT)('accepts a Buffer in addition to a string', () => {
    const buf = Buffer.from(TEST_CERT_PEM, 'utf8');
    expect(computeCertFingerprint(buf)).toBe(TEST_CERT_FINGERPRINT);
  });
});

describe('bindH2Tls', () => {
  it.skipIf(!HAVE_CERT)(
    'binds an ephemeral 127.0.0.1 TLS port and surfaces port + fingerprint',
    async () => {
      const server = createSecureServer({
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
        allowHTTP1: false,
      });
      bound = await bindH2Tls(server, {
        host: '127.0.0.1',
        port: 0,
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
      });
      const addr = bound.address();
      expect(addr.kind).toBe('KIND_TCP_LOOPBACK_H2_TLS');
      if (addr.kind !== 'KIND_TCP_LOOPBACK_H2_TLS') throw new Error('unreachable');
      expect(addr.host).toBe('127.0.0.1');
      expect(addr.port).toBeGreaterThan(0);
      expect(addr.certFingerprintSha256).toBe(TEST_CERT_FINGERPRINT);
    },
  );

  it.skipIf(!HAVE_CERT)(
    'serves an end-to-end h2 request with the pinned cert',
    async () => {
      const server = createSecureServer({
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
        allowHTTP1: false,
      });
      server.on('stream', (stream, headers) => {
        if (headers[':path'] === '/ping') {
          stream.respond({ ':status': 200 });
          stream.end('pong');
        } else {
          stream.respond({ ':status': 404 });
          stream.end();
        }
      });
      bound = await bindH2Tls(server, {
        host: '127.0.0.1',
        port: 0,
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
      });
      const addr = bound.address();
      if (addr.kind !== 'KIND_TCP_LOOPBACK_H2_TLS') throw new Error('unreachable');

      h2client = h2connect(`https://127.0.0.1:${addr.port}`, {
        ca: TEST_CERT_PEM,
        servername: 'localhost',
      });
      const body = await new Promise<string>((resolve, reject) => {
        const req = h2client!.request({ ':path': '/ping' });
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
        req.end();
      });
      expect(body).toBe('pong');
    },
  );

  it.skipIf(!HAVE_CERT)('rejects non-loopback host at runtime', async () => {
    const server = createSecureServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM });
    await expect(
      bindH2Tls(server, {
        host: '0.0.0.0' as '127.0.0.1',
        port: 0,
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
      }),
    ).rejects.toThrow(/MUST be 127\.0\.0\.1/);
  });

  it.skipIf(!HAVE_CERT)('rejects out-of-range port', async () => {
    const server = createSecureServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM });
    await expect(
      bindH2Tls(server, {
        host: '127.0.0.1',
        port: 70_000,
        cert: TEST_CERT_PEM,
        key: TEST_KEY_PEM,
      }),
    ).rejects.toThrow(/port out of range/);
  });

  it.skipIf(!HAVE_CERT)('close() is idempotent', async () => {
    const server = createSecureServer({ cert: TEST_CERT_PEM, key: TEST_KEY_PEM });
    bound = await bindH2Tls(server, {
      host: '127.0.0.1',
      port: 0,
      cert: TEST_CERT_PEM,
      key: TEST_KEY_PEM,
    });
    await bound.close();
    await expect(bound.close()).resolves.toBeUndefined();
    bound = null;
  });
});
