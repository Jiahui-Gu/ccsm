// Tests for the principal model — pure functions, exhaustive switch.
// Spec refs: ch05 §1 Principal model + principalKey format.

import { describe, expect, it } from 'vitest';
import { principalKey, type Principal } from '../principal.js';

describe('principalKey', () => {
  it('formats a linux uid principal as "local-user:<uid>"', () => {
    const p: Principal = { kind: 'local-user', uid: '1000', displayName: 'jdoe' };
    expect(principalKey(p)).toBe('local-user:1000');
  });

  it('formats a Windows SID principal verbatim (SID already string-form)', () => {
    const p: Principal = {
      kind: 'local-user',
      uid: 'S-1-5-21-1004336348-1177238915-682003330-1001',
      displayName: 'JDOE',
    };
    expect(principalKey(p)).toBe(
      'local-user:S-1-5-21-1004336348-1177238915-682003330-1001',
    );
  });

  it('formats the test loopback principal as "local-user:test"', () => {
    const p: Principal = { kind: 'local-user', uid: 'test', displayName: 'test' };
    expect(principalKey(p)).toBe('local-user:test');
  });

  it('does NOT include displayName in the key (advisory only — spec ch05 §1)', () => {
    const a: Principal = { kind: 'local-user', uid: '1000', displayName: 'Alice' };
    const b: Principal = { kind: 'local-user', uid: '1000', displayName: 'Bob' };
    expect(principalKey(a)).toBe(principalKey(b));
  });
});
