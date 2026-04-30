import { describe, expect, it } from 'vitest';
import { Value } from '@sinclair/typebox/value';

import {
  DAEMON_PROTOCOL_VERSION,
  DaemonProtocolVersionSchema,
  checkProtocolVersion,
  type DaemonProtocolVersion,
} from '../protocol-version.js';

describe('protocol-version: TypeBox schema', () => {
  it('accepts the pinned integer literal', () => {
    expect(Value.Check(DaemonProtocolVersionSchema, DAEMON_PROTOCOL_VERSION)).toBe(true);
    expect(Value.Check(DaemonProtocolVersionSchema, 1)).toBe(true);
  });

  it('rejects string values per r9 lock (REJECTS string with schema_violation)', () => {
    expect(Value.Check(DaemonProtocolVersionSchema, '1')).toBe(false);
    expect(Value.Check(DaemonProtocolVersionSchema, '0.3')).toBe(false);
  });

  it('rejects other integers and undefined', () => {
    expect(Value.Check(DaemonProtocolVersionSchema, 0)).toBe(false);
    expect(Value.Check(DaemonProtocolVersionSchema, 2)).toBe(false);
    expect(Value.Check(DaemonProtocolVersionSchema, undefined)).toBe(false);
  });

  it('Static<typeof Schema> resolves to the pinned literal at compile time', () => {
    // If the Static type is wrong, this assignment fails to typecheck.
    const v: DaemonProtocolVersion = DAEMON_PROTOCOL_VERSION;
    expect(v).toBe(1);
  });
});

describe('protocol-version: checkProtocolVersion()', () => {
  it('accepts the pinned integer', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: DAEMON_PROTOCOL_VERSION });
    expect(r.valid).toBe(true);
  });

  it('rejects undefined headers with PROTOCOL_VERSION_MISMATCH (no got)', () => {
    const r = checkProtocolVersion(undefined);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.code).toBe('PROTOCOL_VERSION_MISMATCH');
      expect(r.error.expected).toBe(DAEMON_PROTOCOL_VERSION);
      expect(r.error.got).toBeUndefined();
    }
  });

  it('rejects null headers', () => {
    const r = checkProtocolVersion(null);
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.code).toBe('PROTOCOL_VERSION_MISMATCH');
      expect(r.error.got).toBeUndefined();
    }
  });

  it('rejects missing daemonProtocolVersion field with no got', () => {
    const r = checkProtocolVersion({ otherField: 'x' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.code).toBe('PROTOCOL_VERSION_MISMATCH');
      expect(r.error.expected).toBe(1);
      expect(r.error.got).toBeUndefined();
    }
  });

  it('rejects integer 0 and echoes got', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: 0 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.code).toBe('PROTOCOL_VERSION_MISMATCH');
      expect(r.error.got).toBe(0);
    }
  });

  it('rejects integer 2 (future major) and echoes got', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: 2 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.got).toBe(2);
    }
  });

  it('rejects string "1" (r9 lock — string MUST fail)', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: '1' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.got).toBe('1');
    }
  });

  it('rejects string "0.4" and echoes got', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: '0.4' });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.got).toBe('0.4');
    }
  });

  it('rejects float 1.5 (Number.isInteger guard)', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: 1.5 });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.got).toBe(1.5);
    }
  });

  it('rejects null value and echoes got', () => {
    const r = checkProtocolVersion({ daemonProtocolVersion: null });
    expect(r.valid).toBe(false);
    if (!r.valid) {
      expect(r.error.got).toBeNull();
    }
  });
});
