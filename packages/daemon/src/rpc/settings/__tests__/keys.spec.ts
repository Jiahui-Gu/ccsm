// packages/daemon/src/rpc/settings/__tests__/keys.spec.ts
//
// Task #434 (T8.14b-4) — rpc/ coverage push for the SRP-decomposed key
// vocabulary in `../keys.ts`. The constants and helpers exported there
// are the forever-stable storage-key surface (spec #337 §2.4): every
// settings/draft row on disk is named via these strings, so a silent
// drift here orphans rows on upgrade. These specs pin the contract
// without touching any handler — pure-data assertions only.

import { describe, expect, it } from 'vitest';

import { DRAFT_PREFIX, draftKey, ULID_RE, UI_PREFS_PREFIX } from '../keys.js';

describe('keys.ts — forever-stable storage-key vocabulary (Task #434)', () => {
  it('draftKey concatenates the canonical "draft:" prefix to the session id', () => {
    // Spec #337 §2.4 reserves the bare `draft:` prefix; nothing else
    // (no `v2:` segment, no JSON envelope) lives in the key. If that
    // ever changes the spec must amend §2.4 and this assertion gates
    // the rename — review-time visible, not a silent migration.
    const sid = '01J0000000000000000000ABCD';
    expect(draftKey(sid)).toBe(`draft:${sid}`);
    expect(draftKey(sid).startsWith(DRAFT_PREFIX)).toBe(true);
    // The bare `draft:` prefix is intentionally distinct from
    // `ui_prefs.draft:` so GetSettings cannot confuse a draft row for
    // a ui_prefs entry (spec §2.2 + §9 q6).
    expect(draftKey(sid).startsWith(UI_PREFS_PREFIX)).toBe(false);
  });

  it('ULID_RE accepts a valid Crockford ULID and rejects malformed ids', () => {
    // Defence-in-depth gate (spec #337 §8.3) — better-sqlite3 already
    // bound-protects against SQL injection, but the regex stops garbage
    // ids at the wire boundary before any storage row is written.
    // Hot path: well-formed ULID accepted.
    expect(ULID_RE.test('01J0000000000000000000ABCD')).toBe(true);

    // Error branches:
    // - too short
    expect(ULID_RE.test('01J')).toBe(false);
    // - lowercase letters (Crockford ULID is upper-only)
    expect(ULID_RE.test('01j0000000000000000000abcd')).toBe(false);
    // - reserved letters in Crockford alphabet (I/L/O/U)
    expect(ULID_RE.test('01J000000000000000000000IL')).toBe(false);
    // - empty string
    expect(ULID_RE.test('')).toBe(false);
  });
});
