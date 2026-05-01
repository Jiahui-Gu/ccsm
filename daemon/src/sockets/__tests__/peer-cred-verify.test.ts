import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import {
  loadDefaultDeps,
  verifyPeerCred,
  type NativePeerCredDeps,
} from '../peer-cred-verify.js';

// T46 — Sender peer-cred verification tests.
//
// The verifier branches on `process.platform`; we exercise all three
// branches on a single CI host by passing `options.platform`
// explicitly. That keeps the production code path identical (the
// override is opt-in, defaults to `process.platform`) while letting
// Linux / macOS / Win runners cover the same code paths.
//
// Reverse-verify:
//   - Each "same user" test asserts `same === true`.
//   - Each "different user" test asserts `same === false` AND that
//     the verifier did NOT throw (caller decides what to do).
//   - Native-throw tests assert the error bubbles (programmer /
//     environmental error, distinct from a security-event mismatch).

const fakeSocket = {} as unknown as Socket;

describe('verifyPeerCred — win32', () => {
  it('returns { same: true } when peer SID matches expectedSid', () => {
    const expectedSid = 'S-1-5-21-1111-2222-3333-1001';
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 4242,
      openProcessTokenUserSid: () => expectedSid,
    };
    const result = verifyPeerCred(
      fakeSocket,
      { expectedSid },
      { deps, platform: 'win32' },
    );
    expect(result.same).toBe(true);
    expect(result.peer.pid).toBe(4242);
    expect(result.peer.sid).toBe(expectedSid);
    expect(result.peer.uid).toBeUndefined();
    expect(result.peer.gid).toBeUndefined();
  });

  it('returns { same: false } when peer SID differs (no throw)', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 9999,
      openProcessTokenUserSid: () => 'S-1-5-21-9999-9999-9999-1001',
    };
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedSid: 'S-1-5-21-1111-2222-3333-1001' },
        { deps, platform: 'win32' },
      ),
    ).not.toThrow();
    const result = verifyPeerCred(
      fakeSocket,
      { expectedSid: 'S-1-5-21-1111-2222-3333-1001' },
      { deps, platform: 'win32' },
    );
    expect(result.same).toBe(false);
    expect(result.peer.pid).toBe(9999);
    expect(result.peer.sid).toBe('S-1-5-21-9999-9999-9999-1001');
  });

  it('chains GetNamedPipeClientProcessId → OpenProcessTokenUserSid (pid threaded)', () => {
    const getPid = vi.fn(() => 7777);
    const openSid = vi.fn((pid: number) => `S-1-5-21-x-x-x-${pid}`);
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: getPid,
      openProcessTokenUserSid: openSid,
    };
    verifyPeerCred(
      fakeSocket,
      { expectedSid: 'irrelevant' },
      { deps, platform: 'win32' },
    );
    expect(getPid).toHaveBeenCalledWith(fakeSocket);
    expect(openSid).toHaveBeenCalledWith(7777);
  });

  it('throws when expectedUid passed instead of expectedSid', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 1,
      openProcessTokenUserSid: () => 'S-x',
    };
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        // @ts-expect-error intentionally wrong shape
        { expectedUid: 1000 },
        { deps, platform: 'win32' },
      ),
    ).toThrowError(/win32 requires \{ expectedSid/);
  });

  it('throws when win32 deps missing (frag-11 pointer)', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedSid: 'S-x' },
        { deps: {}, platform: 'win32' },
      ),
    ).toThrowError(/Wire ccsm_native \(frag-11\)/);
  });

  it('lets native-call throws bubble (dead pid / access denied)', () => {
    const err = new Error('OpenProcessToken: ERROR_ACCESS_DENIED');
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 1,
      openProcessTokenUserSid: () => {
        throw err;
      },
    };
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedSid: 'S-x' },
        { deps, platform: 'win32' },
      ),
    ).toThrow(err);
  });
});

describe('verifyPeerCred — linux', () => {
  it('returns { same: true } when peer uid matches expectedUid', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: 1000, gid: 1000, pid: 4242 }),
    };
    const result = verifyPeerCred(
      fakeSocket,
      { expectedUid: 1000 },
      { deps, platform: 'linux' },
    );
    expect(result.same).toBe(true);
    expect(result.peer).toEqual({ uid: 1000, gid: 1000, pid: 4242 });
    expect(result.peer.sid).toBeUndefined();
  });

  it('returns { same: false } when peer uid differs (no throw)', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: 1001, gid: 1000, pid: 4242 }),
    };
    const result = verifyPeerCred(
      fakeSocket,
      { expectedUid: 1000 },
      { deps, platform: 'linux' },
    );
    expect(result.same).toBe(false);
    expect(result.peer.uid).toBe(1001);
    expect(result.peer.pid).toBe(4242);
  });

  it('forwards the socket to getsockoptPeerCred', () => {
    const fn = vi.fn(() => ({ uid: 1000, gid: 1000, pid: 1 }));
    verifyPeerCred(
      fakeSocket,
      { expectedUid: 1000 },
      { deps: { getsockoptPeerCred: fn }, platform: 'linux' },
    );
    expect(fn).toHaveBeenCalledWith(fakeSocket);
  });

  it('throws when expectedSid passed instead of expectedUid', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        // @ts-expect-error intentionally wrong shape
        { expectedSid: 'S-x' },
        {
          deps: { getsockoptPeerCred: () => ({ uid: 1, gid: 1, pid: 1 }) },
          platform: 'linux',
        },
      ),
    ).toThrowError(/linux requires \{ expectedUid/);
  });

  it('throws when linux deps missing (frag-11 pointer)', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedUid: 1000 },
        { deps: {}, platform: 'linux' },
      ),
    ).toThrowError(/Wire ccsm_native \(frag-11\)/);
  });

  it('lets native-call throws bubble (ENOTSOCK etc.)', () => {
    const err = new Error('getsockopt SO_PEERCRED: ENOTSOCK');
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => {
        throw err;
      },
    };
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedUid: 1000 },
        { deps, platform: 'linux' },
      ),
    ).toThrow(err);
  });
});

describe('verifyPeerCred — darwin', () => {
  it('returns { same: true } when peer uid matches expectedUid', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: 501, gid: 20 }),
    };
    const result = verifyPeerCred(
      fakeSocket,
      { expectedUid: 501 },
      { deps, platform: 'darwin' },
    );
    expect(result.same).toBe(true);
    expect(result.peer.uid).toBe(501);
    expect(result.peer.gid).toBe(20);
    // getpeereid does NOT return a pid; callers must tolerate undefined.
    expect(result.peer.pid).toBeUndefined();
    expect(result.peer.sid).toBeUndefined();
  });

  it('returns { same: false } when peer uid differs (no throw)', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: 502, gid: 20 }),
    };
    const result = verifyPeerCred(
      fakeSocket,
      { expectedUid: 501 },
      { deps, platform: 'darwin' },
    );
    expect(result.same).toBe(false);
    expect(result.peer.uid).toBe(502);
  });

  it('forwards the socket to getpeereid', () => {
    const fn = vi.fn(() => ({ uid: 501, gid: 20 }));
    verifyPeerCred(
      fakeSocket,
      { expectedUid: 501 },
      { deps: { getpeereid: fn }, platform: 'darwin' },
    );
    expect(fn).toHaveBeenCalledWith(fakeSocket);
  });

  it('throws when expectedSid passed instead of expectedUid', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        // @ts-expect-error intentionally wrong shape
        { expectedSid: 'S-x' },
        {
          deps: { getpeereid: () => ({ uid: 501, gid: 20 }) },
          platform: 'darwin',
        },
      ),
    ).toThrowError(/darwin requires \{ expectedUid/);
  });

  it('throws when darwin deps missing (frag-11 pointer)', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedUid: 501 },
        { deps: {}, platform: 'darwin' },
      ),
    ).toThrowError(/Wire ccsm_native \(frag-11\)/);
  });
});

describe('verifyPeerCred — unsupported platform', () => {
  it('throws on freebsd / aix / etc. (frag-12 §12.1 matrix)', () => {
    expect(() =>
      verifyPeerCred(
        fakeSocket,
        { expectedUid: 1000 },
        { deps: {}, platform: 'freebsd' as NodeJS.Platform },
      ),
    ).toThrowError(/unsupported platform "freebsd"/);
  });
});

describe('loadDefaultDeps', () => {
  it('throws frag-11 pointer until ccsm_native binding lands', () => {
    expect(() => loadDefaultDeps()).toThrowError(/frag-11/);
    expect(() => loadDefaultDeps()).toThrowError(/ccsm_native/);
  });

  it('verifyPeerCred with no deps falls through to the frag-11 throw', () => {
    expect(() =>
      verifyPeerCred(fakeSocket, { expectedUid: 1000 }, { platform: 'linux' }),
    ).toThrowError(/frag-11/);
  });
});

// Reverse-verify summary: a flipped expected identity must produce
// `same: false` rather than `same: true`. The dedicated "different
// user" tests above cover this per platform; this block belt-and-
// braces it by inverting the expected on each platform with
// otherwise-known-good deps.
describe('verifyPeerCred — reverse-verify (flip expected)', () => {
  it('win32: matching deps + wrong expectedSid → same:false', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 4242,
      openProcessTokenUserSid: () => 'S-1-5-21-A',
    };
    expect(
      verifyPeerCred(
        fakeSocket,
        { expectedSid: 'S-1-5-21-A' },
        { deps, platform: 'win32' },
      ).same,
    ).toBe(true);
    expect(
      verifyPeerCred(
        fakeSocket,
        { expectedSid: 'S-1-5-21-B' },
        { deps, platform: 'win32' },
      ).same,
    ).toBe(false);
  });

  it('linux: matching deps + wrong expectedUid → same:false', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: 1000, gid: 1000, pid: 1 }),
    };
    expect(
      verifyPeerCred(fakeSocket, { expectedUid: 1000 }, { deps, platform: 'linux' })
        .same,
    ).toBe(true);
    expect(
      verifyPeerCred(fakeSocket, { expectedUid: 1001 }, { deps, platform: 'linux' })
        .same,
    ).toBe(false);
  });

  it('darwin: matching deps + wrong expectedUid → same:false', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: 501, gid: 20 }),
    };
    expect(
      verifyPeerCred(fakeSocket, { expectedUid: 501 }, { deps, platform: 'darwin' })
        .same,
    ).toBe(true);
    expect(
      verifyPeerCred(fakeSocket, { expectedUid: 502 }, { deps, platform: 'darwin' })
        .same,
    ).toBe(false);
  });
});
