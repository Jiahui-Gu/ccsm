// Spec for the Listener A transport picker — pure decider per spec
// ch03 §4 (transport pick) + §1a (closed BindDescriptor enum).

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { pickTransportForListenerA } from '../transport-pick.js';
import type { DaemonEnv } from '../../env.js';
import { RESERVED_FOR_LISTENER_B } from '../../env.js';

function envWith(listenerAddr: string): DaemonEnv {
  return {
    mode: 'dev',
    paths: {
      stateDir: '/tmp/ccsm-state',
      descriptorPath: '/tmp/ccsm-state/listener-a.json',
      listenerAddr,
      supervisorAddr: '/tmp/ccsm-state/supervisor.sock',
    },
    listeners: [null, RESERVED_FOR_LISTENER_B] as const,
    bootId: '550e8400-e29b-41d4-a716-446655440000',
    version: '0.3.0-dev',
    buildCommit: 'dev',
  };
}

describe('pickTransportForListenerA', () => {
  let savedForce: string | undefined;

  beforeEach(() => {
    savedForce = process.env.CCSM_LISTENER_A_FORCE_LOOPBACK;
    delete process.env.CCSM_LISTENER_A_FORCE_LOOPBACK;
  });

  afterEach(() => {
    if (savedForce === undefined) {
      delete process.env.CCSM_LISTENER_A_FORCE_LOOPBACK;
    } else {
      process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = savedForce;
    }
  });

  it('picks UDS on linux (A1 default)', () => {
    const env = envWith('/run/ccsm/daemon.sock');
    const desc = pickTransportForListenerA(env, 'linux');
    expect(desc).toEqual({ kind: 'KIND_UDS', path: '/run/ccsm/daemon.sock' });
  });

  it('picks UDS on darwin (A1 default)', () => {
    const env = envWith('/var/run/com.ccsm.daemon/daemon.sock');
    const desc = pickTransportForListenerA(env, 'darwin');
    expect(desc).toEqual({
      kind: 'KIND_UDS',
      path: '/var/run/com.ccsm.daemon/daemon.sock',
    });
  });

  it('picks named-pipe on win32 (A4 default)', () => {
    const env = envWith('\\\\.\\pipe\\ccsm-daemon');
    const desc = pickTransportForListenerA(env, 'win32');
    expect(desc).toEqual({
      kind: 'KIND_NAMED_PIPE',
      pipeName: '\\\\.\\pipe\\ccsm-daemon',
    });
  });

  it('honours CCSM_LISTENER_A_FORCE_LOOPBACK=1 on every platform (A2 fallback)', () => {
    process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
    const env = envWith('/run/ccsm/daemon.sock');
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const desc = pickTransportForListenerA(env, platform);
      expect(desc).toEqual({ kind: 'KIND_TCP_LOOPBACK_H2C', host: '127.0.0.1', port: 0 });
    }
  });

  it('ignores CCSM_LISTENER_A_FORCE_LOOPBACK values other than literal "1"', () => {
    const env = envWith('/run/ccsm/daemon.sock');
    for (const v of ['true', 'yes', '0', '', 'TRUE']) {
      process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = v;
      const desc = pickTransportForListenerA(env, 'linux');
      expect(desc.kind).toBe('KIND_UDS');
    }
  });

  it('forwards env.paths.listenerAddr verbatim (single source of truth)', () => {
    const custom = '/tmp/ccsm-test-override.sock';
    const env = envWith(custom);
    const desc = pickTransportForListenerA(env, 'linux');
    expect(desc).toEqual({ kind: 'KIND_UDS', path: custom });
  });

  it('never returns the tls variant in v0.3 (reserved for v0.4 Listener B)', () => {
    const env = envWith('/run/ccsm/daemon.sock');
    for (const platform of ['linux', 'darwin', 'win32'] as const) {
      const desc = pickTransportForListenerA(env, platform);
      expect(desc.kind).not.toBe('KIND_TCP_LOOPBACK_H2_TLS');
    }
    process.env.CCSM_LISTENER_A_FORCE_LOOPBACK = '1';
    expect(pickTransportForListenerA(env, 'linux').kind).not.toBe('KIND_TCP_LOOPBACK_H2_TLS');
  });
});
