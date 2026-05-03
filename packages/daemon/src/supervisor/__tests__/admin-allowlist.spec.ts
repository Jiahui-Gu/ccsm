// Unit tests for admin allowlist decider — pure, no I/O. Spec refs ch03 §7.1.

import { describe, expect, it } from 'vitest';
import {
  defaultAdminAllowlist,
  isAllowed,
  SID_BUILTIN_ADMINISTRATORS,
  SID_LOCAL_SERVICE,
  type AdminAllowlist,
} from '../admin-allowlist.js';
import type { NamedPipePeerCred, UdsPeerCred } from '../../auth/peer-info.js';

const udsPeer = (uid: number): UdsPeerCred => ({
  transport: 'uds',
  uid,
  gid: 100,
  pid: 4242,
});

const npPeer = (sid: string): NamedPipePeerCred => ({
  transport: 'namedPipe',
  sid,
  displayName: '',
});

describe('defaultAdminAllowlist', () => {
  it('linux: includes uid 0 and the daemon euid', () => {
    const al = defaultAdminAllowlist('linux', () => 998);
    expect(al.uids.has(0)).toBe(true);
    expect(al.uids.has(998)).toBe(true);
    expect(al.uids.has(1000)).toBe(false);
    expect(al.sids.size).toBe(0);
  });

  it('darwin: includes uid 0 and the daemon euid (the _ccsm account)', () => {
    const al = defaultAdminAllowlist('darwin', () => 213);
    expect(al.uids.has(0)).toBe(true);
    expect(al.uids.has(213)).toBe(true);
    expect(al.sids.size).toBe(0);
  });

  it('win32: includes BUILTIN\\Administrators + LocalService SIDs and no uids', () => {
    const al = defaultAdminAllowlist('win32', () => -1);
    expect(al.sids.has(SID_BUILTIN_ADMINISTRATORS)).toBe(true);
    expect(al.sids.has(SID_LOCAL_SERVICE)).toBe(true);
    expect(al.uids.size).toBe(0);
  });

  it('linux: drops a negative euid (non-POSIX runtime fallback)', () => {
    const al = defaultAdminAllowlist('linux', () => -1);
    expect(al.uids.has(0)).toBe(true);
    expect(al.uids.has(-1)).toBe(false);
  });
});

describe('isAllowed', () => {
  const linuxAl: AdminAllowlist = { uids: new Set([0, 998]), sids: new Set() };
  const winAl: AdminAllowlist = {
    uids: new Set(),
    sids: new Set([SID_BUILTIN_ADMINISTRATORS, SID_LOCAL_SERVICE]),
  };

  it('UDS: allows root', () => {
    expect(isAllowed(linuxAl, udsPeer(0))).toBe(true);
  });

  it('UDS: allows the ccsm service uid', () => {
    expect(isAllowed(linuxAl, udsPeer(998))).toBe(true);
  });

  it('UDS: denies a regular user uid (spec ch03 §7.1 — Electron is NOT admin)', () => {
    expect(isAllowed(linuxAl, udsPeer(1000))).toBe(false);
  });

  it('namedPipe: allows LocalService SID directly', () => {
    expect(isAllowed(winAl, npPeer(SID_LOCAL_SERVICE))).toBe(true);
  });

  it('namedPipe: denies an arbitrary user SID with no membership callback', () => {
    expect(isAllowed(winAl, npPeer('S-1-5-21-1111-2222-3333-1001'))).toBe(false);
  });

  it('namedPipe: allows when the membership callback says yes', () => {
    const userSid = 'S-1-5-21-1111-2222-3333-500';
    expect(
      isAllowed(winAl, npPeer(userSid), (sid) => sid === userSid),
    ).toBe(true);
  });

  it('namedPipe: denies when the membership callback says no', () => {
    expect(
      isAllowed(winAl, npPeer('S-1-5-21-9-9-9-1001'), () => false),
    ).toBe(false);
  });
});
