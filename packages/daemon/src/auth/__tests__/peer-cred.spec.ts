// Tests for the per-OS peer-cred extractors. The extractors are
// transport adapters' producers — pure (modulo the injected lookup
// callback) so we exercise them with mock callbacks instead of real
// sockets. Spec refs: ch03 §5 derivation mechanism table; ch05 §3
// derivation rules per transport.

import { describe, expect, it } from 'vitest';
import {
  extractLoopbackTcpPeer,
  extractNamedPipePeerCred,
  extractUdsPeerCred,
  unsupportedNamedPipeLookup,
  unsupportedUdsLookup,
} from '../peer-cred.js';

// We never actually pass a real net.Socket to the extractors — the
// injected `lookup` callback is the only consumer of the socket arg, and
// our tests inject mocks. Cast through `unknown` to satisfy the type.
const FAKE_SOCKET = {} as unknown as Parameters<typeof extractUdsPeerCred>[0];

describe('extractUdsPeerCred', () => {
  it('returns a uds-tagged PeerInfo from the lookup callback', () => {
    const result = extractUdsPeerCred(FAKE_SOCKET, () => ({ uid: 1000, gid: 100, pid: 4321 }));
    expect(result).toEqual({ transport: 'KIND_UDS', uid: 1000, gid: 100, pid: 4321 });
  });

  it('passes through a null pid (macOS LOCAL_PEERPID may be unavailable)', () => {
    const result = extractUdsPeerCred(FAKE_SOCKET, () => ({ uid: 501, gid: 20, pid: null }));
    expect(result.pid).toBeNull();
  });

  it('throws via the unsupported default when no lookup is wired', () => {
    expect(() => extractUdsPeerCred(FAKE_SOCKET)).toThrow(/UDS peer-cred lookup not wired/);
    expect(() => unsupportedUdsLookup(FAKE_SOCKET)).toThrow();
  });

  it('propagates a syscall failure (kernel rejects getsockopt)', () => {
    expect(() =>
      extractUdsPeerCred(FAKE_SOCKET, () => {
        throw new Error('ENOTCONN');
      }),
    ).toThrow(/ENOTCONN/);
  });
});

describe('extractNamedPipePeerCred', () => {
  it('returns a namedPipe-tagged PeerInfo with SID + display name', () => {
    const sid = 'S-1-5-21-1111-2222-3333-1001';
    const result = extractNamedPipePeerCred(FAKE_SOCKET, () => ({
      sid,
      displayName: 'JDOE',
    }));
    expect(result).toEqual({ transport: 'KIND_NAMED_PIPE', sid, displayName: 'JDOE' });
  });

  it('allows an empty display name (best-effort lookup, spec ch05 §2)', () => {
    const sid = 'S-1-5-21-9-9-9-1001';
    const result = extractNamedPipePeerCred(FAKE_SOCKET, () => ({ sid, displayName: '' }));
    expect(result.displayName).toBe('');
  });

  it('rejects an empty SID — uid MUST resolve (spec ch05 §3)', () => {
    expect(() =>
      extractNamedPipePeerCred(FAKE_SOCKET, () => ({ sid: '', displayName: 'X' })),
    ).toThrow(/empty SID/);
  });

  it('throws via the unsupported default when no lookup is wired', () => {
    expect(() => extractNamedPipePeerCred(FAKE_SOCKET)).toThrow(
      /Named-pipe peer-cred lookup not wired/,
    );
    expect(() => unsupportedNamedPipeLookup(FAKE_SOCKET)).toThrow();
  });
});

describe('extractLoopbackTcpPeer', () => {
  it('parses a Bearer token from the Authorization header', () => {
    const headers = new Headers({ Authorization: 'Bearer test-token' });
    const result = extractLoopbackTcpPeer(headers, '127.0.0.1', 54871);
    expect(result).toEqual({
      transport: 'KIND_TCP_LOOPBACK_H2C',
      bearerToken: 'test-token',
      remoteAddress: '127.0.0.1',
      remotePort: 54871,
    });
  });

  it('matches the Bearer scheme case-insensitively (RFC 6750 §2.1)', () => {
    const headers = new Headers({ Authorization: 'bEaReR test-token' });
    expect(extractLoopbackTcpPeer(headers, '::1', 1).bearerToken).toBe('test-token');
  });

  it('returns bearerToken=null when the header is absent', () => {
    const result = extractLoopbackTcpPeer(new Headers(), '127.0.0.1', 1234);
    expect(result.bearerToken).toBeNull();
  });

  it('returns bearerToken=null for a non-Bearer scheme (e.g. Basic)', () => {
    const headers = new Headers({ Authorization: 'Basic dXNlcjpwdw==' });
    expect(extractLoopbackTcpPeer(headers, '127.0.0.1', 1234).bearerToken).toBeNull();
  });

  it('preserves diagnostic remoteAddress / remotePort regardless of auth outcome', () => {
    const headers = new Headers();
    const result = extractLoopbackTcpPeer(headers, '10.0.0.5', 65535);
    expect(result.remoteAddress).toBe('10.0.0.5');
    expect(result.remotePort).toBe(65535);
  });
});
