// T81 — L8 cross-user ACL probe.
//
// Asserts the daemon's per-platform "same OS user" check at the
// transport boundary (pipeAcl on Win, peer-cred on POSIX) refuses a
// connection from a different OS user and accepts a connection from
// the same OS user. The OS-level peer-identity check is mocked via
// the `NativePeerCredDeps` injection seam (per
// daemon/src/sockets/peer-cred-verify.ts JSDoc); we do NOT actually
// spawn a second user account.
//
// Spec anchors:
//   - frag-6-7-reliability-security.md "Task 26": cross-user access
//     denial repro (manual + scripted).
//   - v0.3-design §3.1.1 transport hardening: "on each accepted
//     connection, daemon validates peer is same user. Win:
//     GetNamedPipeClientProcessId → OpenProcessToken → match user
//     SID. Unix: SO_PEERCRED (Linux) / getpeereid (Mac)."
//   - daemon/src/pty/pipe-acl.ts (T45): Win pipe DACL = current SID
//     only + AccessDenied for BUILTIN\Users + ANONYMOUS LOGON +
//     PIPE_REJECT_REMOTE_CLIENTS. The native binding is the SINK; the
//     L8 contract this probe asserts is the per-accept verifier seam
//     in peer-cred-verify.ts (which is the only piece reachable from
//     JS — the in-pipe DACL fail-fast happens in kernel-space and
//     never surfaces a Node `Socket` accept event for the rejected
//     peer, so the L8 probe asserts the JS-visible decider seam).
//
// Reverse-verify shape (per feedback_bug_fix_test_workflow):
//   - same-user case: `same === true`, no throw → caller would
//     proceed.
//   - cross-user case: `same === false`, no throw → caller would
//     `socket.destroy()` per the JSDoc reject pattern.
// Flipping the expected identity in the cross-user case to match
// the peer flips `same` to true, proving the assertion is load-
// bearing on the comparison and not an artefact of the deps shape.

import { describe, expect, it, vi } from 'vitest';
import type { Socket } from 'node:net';
import {
  verifyPeerCred,
  type NativePeerCredDeps,
} from '../peer-cred-verify.js';

// A bare object stands in for an accepted Socket; the verifier never
// touches its members in tests because we inject the native deps.
const acceptedSocket = {} as unknown as Socket;

// ---------------------------------------------------------------------
// Win32 — pipeAcl + peer-SID mismatch ⇒ reject
// ---------------------------------------------------------------------
describe('cross-user ACL probe — win32 (pipe peer SID)', () => {
  const daemonSid = 'S-1-5-21-1111-2222-3333-1001';
  const otherSid = 'S-1-5-21-9999-9999-9999-2002';

  it('rejects a different-user peer (different SID) — same:false', () => {
    const getPid = vi.fn(() => 4242);
    const openSid = vi.fn(() => otherSid);
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: getPid,
      openProcessTokenUserSid: openSid,
    };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedSid: daemonSid },
      { deps, platform: 'win32' },
    );

    expect(result.same).toBe(false);
    expect(result.peer.sid).toBe(otherSid);
    expect(result.peer.pid).toBe(4242);
    // Native chain was actually invoked (proves we exercised the
    // peer-identity path, not a short-circuit).
    expect(getPid).toHaveBeenCalledWith(acceptedSocket);
    expect(openSid).toHaveBeenCalledWith(4242);
  });

  it('accepts a same-user peer (matching SID) — same:true', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 7777,
      openProcessTokenUserSid: () => daemonSid,
    };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedSid: daemonSid },
      { deps, platform: 'win32' },
    );

    expect(result.same).toBe(true);
    expect(result.peer.sid).toBe(daemonSid);
    expect(result.peer.pid).toBe(7777);
  });

  it('reverse-verify: flipping expected to the peer SID flips same:true', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 1,
      openProcessTokenUserSid: () => otherSid,
    };
    // With expected=daemonSid, peer=otherSid → reject.
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedSid: daemonSid },
        { deps, platform: 'win32' },
      ).same,
    ).toBe(false);
    // Flip expected to the peer's SID — same deps, accept.
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedSid: otherSid },
        { deps, platform: 'win32' },
      ).same,
    ).toBe(true);
  });

  it('does NOT throw on cross-user — caller decides destroy() vs accept', () => {
    const deps: NativePeerCredDeps = {
      getNamedPipeClientProcessId: () => 1,
      openProcessTokenUserSid: () => otherSid,
    };
    // The JSDoc reject pattern is `if (!result.same) socket.destroy()`;
    // the verifier MUST NOT throw on mismatch (that would conflate
    // security event with programmer error).
    expect(() =>
      verifyPeerCred(
        acceptedSocket,
        { expectedSid: daemonSid },
        { deps, platform: 'win32' },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// Linux — SO_PEERCRED uid mismatch ⇒ reject
// ---------------------------------------------------------------------
describe('cross-user ACL probe — linux (SO_PEERCRED uid)', () => {
  const daemonUid = 1000;
  const otherUid = 1001;

  it('rejects a different-user peer (different uid) — same:false', () => {
    const peerCred = vi.fn(() => ({ uid: otherUid, gid: otherUid, pid: 8888 }));
    const deps: NativePeerCredDeps = { getsockoptPeerCred: peerCred };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedUid: daemonUid },
      { deps, platform: 'linux' },
    );

    expect(result.same).toBe(false);
    expect(result.peer.uid).toBe(otherUid);
    expect(result.peer.pid).toBe(8888);
    expect(peerCred).toHaveBeenCalledWith(acceptedSocket);
  });

  it('accepts a same-user peer (matching uid) — same:true', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: daemonUid, gid: daemonUid, pid: 4242 }),
    };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedUid: daemonUid },
      { deps, platform: 'linux' },
    );

    expect(result.same).toBe(true);
    expect(result.peer.uid).toBe(daemonUid);
  });

  it('reverse-verify: flipping expected to the peer uid flips same:true', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: otherUid, gid: otherUid, pid: 1 }),
    };
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: daemonUid },
        { deps, platform: 'linux' },
      ).same,
    ).toBe(false);
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: otherUid },
        { deps, platform: 'linux' },
      ).same,
    ).toBe(true);
  });

  it('does NOT throw on cross-user — caller decides destroy() vs accept', () => {
    const deps: NativePeerCredDeps = {
      getsockoptPeerCred: () => ({ uid: otherUid, gid: otherUid, pid: 1 }),
    };
    expect(() =>
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: daemonUid },
        { deps, platform: 'linux' },
      ),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------
// Darwin — getpeereid uid mismatch ⇒ reject
// ---------------------------------------------------------------------
describe('cross-user ACL probe — darwin (getpeereid uid)', () => {
  const daemonUid = 501;
  const otherUid = 502;

  it('rejects a different-user peer (different uid) — same:false', () => {
    const peereid = vi.fn(() => ({ uid: otherUid, gid: 20 }));
    const deps: NativePeerCredDeps = { getpeereid: peereid };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedUid: daemonUid },
      { deps, platform: 'darwin' },
    );

    expect(result.same).toBe(false);
    expect(result.peer.uid).toBe(otherUid);
    // getpeereid does not return pid — caller must tolerate undefined.
    expect(result.peer.pid).toBeUndefined();
    expect(peereid).toHaveBeenCalledWith(acceptedSocket);
  });

  it('accepts a same-user peer (matching uid) — same:true', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: daemonUid, gid: 20 }),
    };

    const result = verifyPeerCred(
      acceptedSocket,
      { expectedUid: daemonUid },
      { deps, platform: 'darwin' },
    );

    expect(result.same).toBe(true);
    expect(result.peer.uid).toBe(daemonUid);
  });

  it('reverse-verify: flipping expected to the peer uid flips same:true', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: otherUid, gid: 20 }),
    };
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: daemonUid },
        { deps, platform: 'darwin' },
      ).same,
    ).toBe(false);
    expect(
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: otherUid },
        { deps, platform: 'darwin' },
      ).same,
    ).toBe(true);
  });

  it('does NOT throw on cross-user — caller decides destroy() vs accept', () => {
    const deps: NativePeerCredDeps = {
      getpeereid: () => ({ uid: otherUid, gid: 20 }),
    };
    expect(() =>
      verifyPeerCred(
        acceptedSocket,
        { expectedUid: daemonUid },
        { deps, platform: 'darwin' },
      ),
    ).not.toThrow();
  });
});
