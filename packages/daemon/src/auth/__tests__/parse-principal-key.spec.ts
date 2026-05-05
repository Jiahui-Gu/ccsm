// Tests for `parsePrincipalKey` — the inverse of `principalKey()`.
//
// Spec ch15 §3 #7 (enforcement audit P7): the parser MUST use
// `key.indexOf(':')` and slice on the FIRST colon — `split(':')[0/1]`
// is forbidden because v0.4 introduces keys whose `value` legitimately
// contains additional colons (e.g. `cf-access:auth0|abc:def`). The
// round-trip cases below pin that contract: `principalKey({...parse(k)})`
// MUST equal `k` for every well-formed key, including the future
// `cf-access` shape.

import { describe, expect, it } from 'vitest';
import { parsePrincipalKey } from '../principal.js';

describe('parsePrincipalKey', () => {
  it('splits a linux uid key into kind + value', () => {
    expect(parsePrincipalKey('local-user:1000')).toEqual({
      kind: 'local-user',
      value: '1000',
    });
  });

  it('round-trips a Windows SID key (value contains many dashes, no colon)', () => {
    const key = 'local-user:S-1-5-21-1004336348-1177238915-682003330-1001';
    const parsed = parsePrincipalKey(key);
    expect(parsed).toEqual({
      kind: 'local-user',
      value: 'S-1-5-21-1004336348-1177238915-682003330-1001',
    });
    // Inverse: rebuilding `${kind}:${value}` reproduces the original key
    // byte-for-byte. This is the contract `principalKey()` has to honour.
    expect(`${parsed.kind}:${parsed.value}`).toBe(key);
  });

  it('round-trips a future cf-access key whose value contains additional colons', () => {
    // ch15 §3 #7 example: Cloudflare Access JWT `sub` claim of the form
    // `<idp>|<id>` where `<idp>` may itself contain a `:` separator
    // (e.g. `auth0|abc:def`). The first-colon-split rule keeps the full
    // suffix in `value` instead of dropping `:def`.
    const key = 'cf-access:auth0|abc:def';
    const parsed = parsePrincipalKey(key);
    expect(parsed).toEqual({ kind: 'cf-access', value: 'auth0|abc:def' });
    expect(`${parsed.kind}:${parsed.value}`).toBe(key);
  });

  it('round-trips a value containing multiple colons (regression for split-bug)', () => {
    const key = 'cf-access:a:b:c:d';
    const parsed = parsePrincipalKey(key);
    expect(parsed).toEqual({ kind: 'cf-access', value: 'a:b:c:d' });
    expect(`${parsed.kind}:${parsed.value}`).toBe(key);
  });

  it('allows an empty value (kind followed by trailing colon)', () => {
    // Not a valid runtime key today, but the parser is a pure string
    // contract — it MUST NOT special-case empty value. Validation of
    // recognised kinds / non-empty values is the caller's job.
    expect(parsePrincipalKey('local-user:')).toEqual({
      kind: 'local-user',
      value: '',
    });
  });

  it('throws when the key has no colon at all', () => {
    expect(() => parsePrincipalKey('daemon-self')).toThrowError(
      /invalid principalKey: daemon-self \(missing ":"\)/,
    );
  });

  it('throws on the empty string', () => {
    expect(() => parsePrincipalKey('')).toThrowError(/missing ":"/);
  });
});
